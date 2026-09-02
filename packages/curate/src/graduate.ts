import path from "node:path";
import {
  acquireSyncLock,
  brainConfigPath,
  buildIndex,
  confirmCheckpoint,
  cosineSimilarity,
  embedProvider,
  ensureBrainCloned,
  getOrgBrain,
  isGraduatable,
  listNotes,
  listWiredBrainDirs,
  loadBrainConfig,
  loadVectors,
  quietTick,
  recordCheckpoint,
  type Embedder,
  type NewNoteInput,
  type Note,
} from "@cmnwlth/core";
import { curate, defaultCurator, textSimilarity, type RejectedCandidate } from "./curate.js";
import { graduationClusterKey, loadTombstonedKeys, tombstoneDir } from "./tombstone.js";

/**
 * Org-brain graduation (#110, ADR-0023): detect a fact/decision that **recurs across ≥2 project
 * brains** and stage it into the org-brain for manual review. This is the on-demand
 * (`commonwealth graduate --suggest`) counterpart to the within-brain {@link consolidateCanon}
 * pass, and shares its shape: single-writer under the sync lock, deterministic clustering,
 * conservative-by-default. It never crosses the trust boundary silently — three layers enforce it:
 *
 * 1. **opt-in** — only notes marked `graduate: true` are even considered ({@link isGraduatable});
 * 2. **detection guardrails** — a conservative cosine threshold, a lexical corroboration floor, and
 *    a hard "spans ≥2 distinct brains" bar (counted by brain dir, since `source` is advisory);
 * 3. **manual review** — the candidate is created via {@link curate} (secret + dedup gate) and lands
 *    in the org-brain's local `staging/`, awaiting `/commonwealth:promote`. It is NEVER
 *    auto-promoted (that path, `captureCandidates`, is not used here), regardless of any brain's
 *    `autoPromote` flag.
 *
 * Detection reuses the embeddings toolkit (ADR-0021): a single shared {@link Embedder} makes every
 * brain's vectors comparable, and cosine similarity clusters them. No federated cross-brain search
 * is required — this is a local O(n·m) scan over already-registered brains, sufficient for the
 * acceptance bar; an ANN index is future work for large N.
 *
 * REJECT-TOMBSTONES (#172): a candidate a reviewer *rejects* is neither canon nor staged, so a
 * naive later run would re-detect and re-stage it. On reject we record the cluster's stable key in
 * the org-brain's shared tombstone store (see {@link loadTombstonedKeys}); this pass computes each
 * surviving cluster's key and skips tombstoned ones, reporting a `suppressed` count rather than
 * silently dropping them. `--include-rejected` (`GraduateOptions.includeRejected`) resurfaces them.
 *
 * QUIET TICK (#273): this is the most expensive pass in the codebase — it resolves an embeddings
 * provider, may re-index every wired brain, and then runs an O(n·m) cross-brain cosine scan. Run on
 * a schedule it is almost always repeated work for a guaranteed no-op. A cheap checkpoint pre-flight
 * ({@link quietTick}) fingerprints EVERY input the pass reads and skips the whole stage — before the
 * embedder is even resolved — when none of them has changed since the last successful run. The
 * fingerprinted inputs are each project brain's canon, the org-brain's canon (the dedup gate reads
 * it), the org-brain's `staging/` (so a hand-deleted candidate is re-staged rather than lost), and
 * the tombstone store (so a fresh rejection is honoured), and the org-brain's own config (its
 * feature flags gate what may graduate). The checkpoint advances ONLY on a pass that scanned
 * everything: every `skipped:` bail-out, every throw, and any PARTIAL pass that could not read a
 * brain ({@link completed}) leaves it untouched, so that window is re-processed.
 */

/** Default cosine similarity at/above which two same-kind notes count as the same fact. */
export const DEFAULT_RECURRENCE_THRESHOLD = 0.9;

/**
 * Lexical corroboration floor (token-set Jaccard). Applied to every clustered edge so an embedding
 * false-positive — two facts that are semantically adjacent but lexically unrelated — is rejected
 * cheaply before it can graduate. Cross-brain false promotions are the top risk (ADR-0023).
 */
export const RECURRENCE_LEXICAL_FLOOR = 0.3;

/** Options for {@link graduateToOrgBrain}. */
export interface GraduateOptions {
  /** Org-brain directory; defaults to the designated {@link getOrgBrain} pointer. */
  orgBrainDir?: string;
  /** Cosine threshold (default {@link DEFAULT_RECURRENCE_THRESHOLD}). */
  threshold?: number;
  /**
   * Report the plan without staging anything. The org-brain lock is still taken. A dry run
   * BYPASSES the quiet-tick guard and never touches the checkpoint (#273): it is a diagnostic the
   * user asked for explicitly, and its "would stage" answer must not mark a window as processed.
   */
  dryRun?: boolean;
  /**
   * Run the full pass even when the quiet-tick guard says nothing has changed (#273). The escape
   * hatch for "I don't trust the checkpoint".
   */
  force?: boolean;
  /**
   * The one shared embedder used across every brain so vectors are comparable. Injected in tests;
   * in production it is resolved from the org-brain's embeddings config. Passing `null` forces the
   * pass to skip (nothing to compare with).
   */
  embedder?: Embedder | null;
  /** Explicit project-brain dirs (tests); defaults to {@link listWiredBrainDirs}. */
  brainDirs?: string[];
  /** Registry path override (tests), threaded to org-brain + brain enumeration. */
  registryPath?: string;
  /**
   * Re-propose clusters a reviewer previously rejected (#172). Default `false`: tombstoned clusters
   * are skipped and counted in {@link GraduationResult.suppressed}. Set `true` to resurface them.
   */
  includeRejected?: boolean;
}

/** A recurring-fact cluster that graduated (or would, in a dry run). */
export interface GraduationCandidate {
  /** Note kind of the cluster. */
  kind: Note["frontmatter"]["kind"];
  /** Title of the representative note the candidate is built from. */
  title: string;
  /** `<source>/<id>` back-links to the originating project notes (≥2, spanning ≥2 brains). */
  sources: string[];
  /** Distinct project-brain dirs the cluster spans (≥2). */
  brains: string[];
}

/** Outcome of a graduation pass. */
export interface GraduationResult {
  /** Number of surviving cross-brain clusters (each yields one candidate). */
  clusters: number;
  /** The candidates found (always populated, incl. dry-run). */
  candidates: GraduationCandidate[];
  /** Candidates actually staged into the org-brain (empty on dry-run). */
  staged: Note[];
  /** Candidates the org-brain's curate() gate rejected (secret/dedup), if any. */
  rejected: RejectedCandidate[];
  /** Project brains skipped, with why (lock held, no comparable vectors), for transparency. */
  skippedBrains: Array<{ brain: string; reason: string }>;
  /**
   * Cross-brain clusters skipped because a reviewer previously rejected them (#172). Counted, never
   * silently dropped; `includeRejected` sets this to 0 (nothing suppressed). Not included in
   * `clusters`/`candidates`.
   */
  suppressed: number;
  /** Set when the whole pass did nothing (no org-brain, lock held, no embedder). */
  skipped?: string;
  /**
   * Set when the quiet-tick guard skipped the expensive stage because no input brain had changed
   * since this ISO 8601 time (#273). A deliberate no-op, NOT a failure and NOT `skipped:`.
   */
  unchangedSince?: string;
}

/**
 * Whether a pass scanned everything it set out to scan (#273). A brain whose sync lock was held, or
 * whose index rebuild failed, was NOT read — its notes never entered the pool — so the pass is only
 * PARTIALLY complete, and advancing the checkpoint would make the next tick skip that brain
 * entirely until something unrelated changed. That is the silent skip the quiet-tick guard must
 * never introduce, so a partial pass leaves the checkpoint where it was and the window is
 * re-processed. The skips are still reported to the caller either way.
 */
function completed(skippedBrains: GraduationResult["skippedBrains"]): boolean {
  return skippedBrains.length === 0;
}

/** One project note carried through detection with its brain + comparable vector. */
interface PoolEntry {
  brainDir: string;
  /** `source` frontmatter if present, else the brain dir basename — used for back-link refs. */
  source: string;
  note: Note;
  vec: Float32Array;
}

/** Title+body — the same text form the index embeds, so candidate/stored vectors are comparable. */
function noteText(n: Note): string {
  return `${n.frontmatter.title} ${n.body}`;
}

/**
 * Pick a cluster's representative deterministically (verified → newest → smallest id), mirroring
 * {@link consolidateCanon}'s survivor rule so the choice is stable across machines.
 */
function pickRepresentative(cluster: PoolEntry[]): PoolEntry {
  return [...cluster].sort((a, b) => {
    const av = a.note.frontmatter.kind === "memory" ? (a.note.frontmatter.verified ?? "") : "";
    const bv = b.note.frontmatter.kind === "memory" ? (b.note.frontmatter.verified ?? "") : "";
    if (av !== bv) return av < bv ? 1 : -1;
    if (a.note.frontmatter.created !== b.note.frontmatter.created) {
      return a.note.frontmatter.created < b.note.frontmatter.created ? 1 : -1;
    }
    return a.note.frontmatter.id < b.note.frontmatter.id ? -1 : 1;
  })[0]!;
}

/**
 * Cluster a pool by cross-brain recurrence: union two entries iff same kind, DIFFERENT brain, and
 * both cosine ≥ `threshold` and lexical ≥ {@link RECURRENCE_LEXICAL_FLOOR}. Returns only clusters
 * that span ≥2 distinct brains (a fact repeated within one brain is not a graduation).
 */
function clusterByRecurrence(pool: PoolEntry[], threshold: number): PoolEntry[][] {
  const parent = pool.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number): void => {
    parent[find(a)] = find(b);
  };
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const a = pool[i]!;
      const b = pool[j]!;
      if (a.brainDir === b.brainDir) continue; // recurrence is cross-brain by definition
      if (a.note.frontmatter.kind !== b.note.frontmatter.kind) continue;
      if (
        cosineSimilarity(a.vec, b.vec) >= threshold &&
        textSimilarity(noteText(a.note), noteText(b.note)) >= RECURRENCE_LEXICAL_FLOOR
      ) {
        union(i, j);
      }
    }
  }
  const byRoot = new Map<number, PoolEntry[]>();
  pool.forEach((e, i) => {
    const r = find(i);
    (byRoot.get(r) ?? byRoot.set(r, []).get(r)!).push(e);
  });
  return [...byRoot.values()].filter(
    (c) => new Set(c.map((e) => e.brainDir)).size >= 2, // ≥2 DISTINCT brains
  );
}

/**
 * Load a project brain's graduatable notes with comparable vectors. Vectors are populated only when
 * a brain has `semanticDedup` on (default off), so we force a rebuild with the SHARED embedder when
 * they are missing — under that brain's OWN sync lock (ADR-0008: re-indexing mutates its derived
 * state, so it must not race the brain's daemon). Returns `null` (skip this brain) with a reason
 * when the lock is held or a rebuild fails — never throws, never blocks the whole pass.
 */
async function loadComparablePool(
  brainDir: string,
  candidates: Note[],
  embedder: Embedder,
): Promise<{ entries: PoolEntry[] } | { skip: string }> {
  let vectors = await loadVectors(brainDir);
  const missing = candidates.some((n) => !vectors.has(n.frontmatter.id));
  if (missing) {
    const release = await acquireSyncLock(brainDir);
    if (!release) return { skip: "sync lock held (another writer)" };
    try {
      await buildIndex(brainDir, { embedder });
      vectors = await loadVectors(brainDir);
    } catch (err) {
      return { skip: `index rebuild failed: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      await release();
    }
  }
  const entries: PoolEntry[] = [];
  for (const note of candidates) {
    const vec = vectors.get(note.frontmatter.id);
    if (!vec) continue; // still no vector (e.g. empty text) — cannot compare, drop quietly
    entries.push({
      brainDir,
      source: note.frontmatter.source ?? path.basename(brainDir),
      note,
      vec,
    });
  }
  return { entries };
}

/** Build the org-brain candidate note for a surviving cluster, with provenance back-links. */
function synthesizeCandidate(cluster: PoolEntry[]): NewNoteInput {
  const rep = pickRepresentative(cluster);
  // Stable, deduped `<source>/<id>` refs to every originating note, sorted for determinism.
  const refs = [...new Set(cluster.map((e) => `${e.source}/${e.note.frontmatter.id}`))].sort();
  const kind = rep.note.frontmatter.kind;
  // memory carries `sources[]`; decision has no sources field, so provenance goes into `relates[]`.
  // `graduated_from` records the origins for audit (and future idempotency).
  const fields: Record<string, unknown> =
    kind === "memory"
      ? { sources: refs, graduated_from: refs }
      : { relates: refs, graduated_from: refs };
  return {
    kind,
    title: rep.note.frontmatter.title,
    body: rep.note.body,
    tags: rep.note.frontmatter.tags,
    // `source` is left UNSET: a graduated fact is org-wide, not owned by one project.
    fields,
  };
}

/**
 * Run one graduation pass. Locates the org-brain, scans every wired project brain for opted-in
 * notes that recur across ≥2 brains, and stages one candidate per cluster into the org-brain for
 * manual review. See the module docstring for the guarantees. Returns what it found/staged, or a
 * `skipped` reason when it could not run (no org-brain, lock held, no embedder).
 */
export async function graduateToOrgBrain(opts: GraduateOptions = {}): Promise<GraduationResult> {
  const empty = (skipped: string): GraduationResult => ({
    clusters: 0,
    candidates: [],
    staged: [],
    rejected: [],
    skippedBrains: [],
    suppressed: 0,
    skipped,
  });
  const threshold = opts.threshold ?? DEFAULT_RECURRENCE_THRESHOLD;

  // 1) Locate the org-brain (explicit dir, else the registry pointer); clone on demand if needed.
  let orgBrainDir = opts.orgBrainDir;
  let orgRemote: string | undefined;
  if (!orgBrainDir) {
    const org = await getOrgBrain({ registryPath: opts.registryPath });
    if (!org) return empty("no org-brain designated (see `commonwealth org-brain set`)");
    orgBrainDir = org.brain;
    orgRemote = org.remote;
  }
  orgBrainDir = path.resolve(orgBrainDir);
  await ensureBrainCloned(orgBrainDir, orgRemote); // no-op when it already exists; clones when it can

  // 2) Single-writer over the org-brain for the whole pass.
  const release = await acquireSyncLock(orgBrainDir);
  if (!release) return empty("another writer holds the org-brain sync lock");
  try {
    // 3) Enumerate project brains (org-brain excluded), dedupe by absolute path. Cheap (a registry
    //    read), and it must happen before the quiet-tick check so the fingerprint covers every
    //    brain the pass would actually read.
    const orgAbs = orgBrainDir;
    const brainDirs = [
      ...new Set(
        (opts.brainDirs ?? (await listWiredBrainDirs({ registryPath: opts.registryPath })))
          .map((d) => path.resolve(d))
          .filter((d) => d !== orgAbs),
      ),
    ];

    // 4) Quiet-tick pre-flight (#273) — deliberately BEFORE the embedder is resolved, which is the
    //    expensive part (it can load a local model). Keyed on the org-brain, since that is the
    //    brain this pass writes to and whose derived index area holds the checkpoint. Captured now,
    //    recorded only after the pass completes, so any throw below re-processes this window.
    let fingerprint: string | undefined;
    if (!opts.dryRun) {
      const tick = await quietTick(orgAbs, "graduate", {
        trees: [orgAbs, path.join(orgAbs, "staging"), ...brainDirs],
        dirs: [tombstoneDir(orgAbs)],
        // The org config is a real input, not decoration: `features.autoAdr` decides whether
        // decisions may graduate at all, and `features.semanticDedup` + `embeddings` change how
        // curate()'s gate judges the candidates. Flipping a flag must NOT read as a quiet tick.
        files: [brainConfigPath(orgAbs)],
        params: { threshold, includeRejected: opts.includeRejected === true },
      });
      if (tick.unchanged && !opts.force) {
        await confirmCheckpoint(orgAbs, "graduate", Date.now());
        return {
          clusters: 0,
          candidates: [],
          staged: [],
          rejected: [],
          skippedBrains: [],
          suppressed: 0,
          unchangedSince: tick.since,
        };
      }
      fingerprint = tick.fingerprint;
    }

    // 5) Resolve the ONE shared embedder — the whole cross-brain comparison rests on it.
    let embedder: Embedder | null;
    if (opts.embedder !== undefined) {
      embedder = opts.embedder;
    } else {
      const orgConfig = await loadBrainConfig(orgBrainDir);
      try {
        embedder = await embedProvider(orgConfig.embeddings);
      } catch {
        embedder = null;
      }
    }
    // No embedder ⇒ the pass could not run. `empty()` returns a `skipped:` result WITHOUT recording
    // the checkpoint, so once a provider is configured the same window is processed in full.
    if (!embedder) return empty("no embedder available for cross-brain comparison");

    // decisions graduate only when the org-brain captures decisions as canon (mirrors curate()).
    const orgConfig = await loadBrainConfig(orgBrainDir);
    const allowDecisions = Boolean(orgConfig.features.autoAdr);

    // 6) Build the cross-brain pool of opted-in notes with comparable vectors.
    const pool: PoolEntry[] = [];
    const skippedBrains: GraduationResult["skippedBrains"] = [];
    for (const dir of brainDirs) {
      const notes = await listNotes(dir);
      const eligible = notes.filter((n) => isGraduatable(n, { allowDecisions }));
      if (eligible.length === 0) continue;
      const loaded = await loadComparablePool(dir, eligible, embedder);
      if ("skip" in loaded) {
        skippedBrains.push({ brain: dir, reason: loaded.skip });
        continue;
      }
      pool.push(...loaded.entries);
    }

    // 7) Cluster, drop reviewer-rejected clusters (#172), synthesize candidates, stage via curate().
    //    A cluster's key is a stable hash of its origin refs — the same identity the tombstone was
    //    written under on reject — so a rejected cluster is skipped even after paraphrase, as long
    //    as it still clusters to the same origin set. Skips are counted, never silently dropped.
    const allClusters = clusterByRecurrence(pool, threshold);
    const tombstoned = opts.includeRejected
      ? new Set<string>()
      : await loadTombstonedKeys(orgBrainDir);
    const candidates: GraduationCandidate[] = [];
    const inputs: NewNoteInput[] = [];
    let suppressed = 0;
    for (const cluster of allClusters) {
      const rep = pickRepresentative(cluster);
      const refs = [...new Set(cluster.map((e) => `${e.source}/${e.note.frontmatter.id}`))].sort();
      if (tombstoned.has(graduationClusterKey(refs))) {
        suppressed++;
        console.error(
          `[commonwealth-curate] graduate: skipping previously-rejected cluster "${rep.note.frontmatter.title}"`,
        );
        continue;
      }
      candidates.push({
        kind: rep.note.frontmatter.kind,
        title: rep.note.frontmatter.title,
        sources: refs,
        brains: [...new Set(cluster.map((e) => e.brainDir))].sort(),
      });
      inputs.push(synthesizeCandidate(cluster));
    }

    if (opts.dryRun || inputs.length === 0) {
      // Nothing to stage is still a completed pass, so the checkpoint advances (a dry run never
      // has a fingerprint, so it cannot) — unless a brain was skipped; see {@link completed}.
      if (fingerprint !== undefined && completed(skippedBrains)) {
        await recordCheckpoint(orgAbs, "graduate", fingerprint, Date.now());
      }
      return {
        clusters: candidates.length,
        candidates,
        staged: [],
        rejected: [],
        skippedBrains,
        suppressed,
      };
    }

    // curate() runs the secret + dedup gate and stages into the org-brain's local staging/ —
    // NEVER captureCandidates, so nothing auto-promotes across the trust boundary.
    const curateResult = await curate(orgBrainDir, inputs, defaultCurator, embedder);
    // Success ⇒ advance the checkpoint. As with consolidate, the fingerprint describes the inputs
    // BEFORE staging, so a pass that staged something leaves the org-brain looking "changed" and
    // the next tick runs once more before settling quiet.
    if (fingerprint !== undefined && completed(skippedBrains)) {
      await recordCheckpoint(orgAbs, "graduate", fingerprint, Date.now());
    }
    return {
      clusters: candidates.length,
      candidates,
      staged: curateResult.staged,
      rejected: curateResult.rejected,
      skippedBrains,
      suppressed,
    };
  } finally {
    await release();
  }
}
