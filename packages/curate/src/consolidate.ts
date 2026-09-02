import {
  acquireSyncLock,
  confirmCheckpoint,
  listNotes,
  quietTick,
  recordCheckpoint,
  supersedeNote,
  type Note,
} from "@cmnwlth/core";
import { textSimilarity } from "./curate.js";

/**
 * Cross-user canon consolidation (ADR-0008 / #29). Write-time dedup only sees canon + local
 * staging, so two machines can independently land near-duplicate canon notes; once they merge,
 * this pass reconciles them. It is:
 *
 * - **supersede-not-delete**: a duplicate is marked `status: superseded` + `superseded_by: <survivor>`
 *   (additive, union-merges) — never deleted, so history and the reconciliation stay visible;
 * - **single-writer**: gated by the same cross-process sync lock the daemon uses, so two
 *   consolidations (or a consolidation and a sync) can't fight;
 * - **conservative + deterministic**: only very-near duplicates of the SAME kind, and only the
 *   supersede-able kinds (memory, decision — the only ones with `status`/`superseded_by`).
 *
 * Similarity is the deterministic token-set Jaccard today; the pluggable embedder/curator seam
 * (ADR-0005) can replace it later without changing this control flow.
 *
 * QUIET TICK (#273): the clustering above is O(n²) token-set comparisons over all of canon, so on a
 * schedule over a mostly-quiescent brain it is repeated work for a guaranteed no-op. A cheap
 * checkpoint pre-flight (see {@link quietTick}) skips the whole stage when canon has not changed
 * since the last successful pass, and the checkpoint advances ONLY on success.
 */

/** Default similarity at/above which two same-kind canon notes are treated as duplicates. */
export const DEFAULT_CONSOLIDATE_THRESHOLD = 0.9;

/** One superseded note and the survivor it now points to. */
export interface Supersession {
  /** Id of the note that was superseded. */
  id: string;
  /** Repo-relative path of the superseded note (its file is kept). */
  path: string;
  /** Id of the surviving note it now defers to. */
  survivor: string;
}

/** Outcome of a consolidation pass. */
export interface ConsolidationResult {
  /** Duplicate clusters found (each collapses to one survivor). */
  clusters: number;
  /** Every supersession applied, in id order. */
  superseded: Supersession[];
  /** Set when the pass did nothing because another writer holds the lock (single-writer). */
  skipped?: string;
  /**
   * Set when the quiet-tick guard skipped the expensive stage because canon had not changed since
   * this ISO 8601 time (#273). This is a deliberate no-op, NOT a failure and NOT `skipped:` — the
   * caller reports it as "nothing changed", and `clusters`/`superseded` are empty because there was
   * genuinely nothing to do.
   */
  unchangedSince?: string;
}

/** Options for {@link consolidateCanon}. */
export interface ConsolidateOptions {
  /** Similarity threshold (default {@link DEFAULT_CONSOLIDATE_THRESHOLD}). */
  threshold?: number;
  /**
   * Report the plan without writing (no supersessions applied). The lock is still taken so the
   * preview reflects a quiescent tree. A dry run BYPASSES the quiet-tick guard and never touches
   * the checkpoint: it is a diagnostic the user asked for explicitly, and its "would supersede"
   * answer must not be able to mark a window as processed.
   */
  dryRun?: boolean;
  /**
   * Run the full pass even when the quiet-tick guard says canon has not changed (#273). The escape
   * hatch for "I don't trust the checkpoint" — e.g. after a threshold change we can't see, or an
   * edit that preserved both size and mtime.
   */
  force?: boolean;
}

/** Title+body text used for similarity. */
function noteText(n: Note): string {
  return `${n.frontmatter.title} ${n.body}`;
}

/**
 * Pick the surviving note of a duplicate cluster deterministically: prefer a `verified` note
 * (most recently verified), then the most recently `created`, then the lexicographically
 * smallest id. Keeping the most-checked/newest note is the safest default; the tiebreak keeps
 * the choice stable across machines.
 */
function pickSurvivor(cluster: Note[]): Note {
  return [...cluster].sort((a, b) => {
    const av = a.frontmatter.kind === "memory" ? (a.frontmatter.verified ?? "") : "";
    const bv = b.frontmatter.kind === "memory" ? (b.frontmatter.verified ?? "") : "";
    if (av !== bv) return av < bv ? 1 : -1; // later verified date first
    if (a.frontmatter.created !== b.frontmatter.created) {
      return a.frontmatter.created < b.frontmatter.created ? 1 : -1; // newer first
    }
    return a.frontmatter.id < b.frontmatter.id ? -1 : 1; // stable tiebreak
  })[0]!;
}

/** Group `notes` into clusters where each note is transitively ≥ `threshold` similar to another. */
function clusterBySimilarity(notes: Note[], threshold: number): Note[][] {
  const parent = notes.map((_, i) => i);
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
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      if (textSimilarity(noteText(notes[i]!), noteText(notes[j]!)) >= threshold) union(i, j);
    }
  }
  const byRoot = new Map<number, Note[]>();
  notes.forEach((n, i) => {
    const r = find(i);
    (byRoot.get(r) ?? byRoot.set(r, []).get(r)!).push(n);
  });
  return [...byRoot.values()].filter((c) => c.length > 1);
}

/**
 * Run one consolidation pass over `brainDir`'s canon (see the module docstring). Returns what it
 * superseded (or `skipped` when another writer holds the lock). Never deletes; never runs
 * concurrently with a sync.
 */
export async function consolidateCanon(
  brainDir: string,
  opts: ConsolidateOptions = {},
): Promise<ConsolidationResult> {
  const threshold = opts.threshold ?? DEFAULT_CONSOLIDATE_THRESHOLD;

  const release = await acquireSyncLock(brainDir);
  if (!release)
    return { clusters: 0, superseded: [], skipped: "another writer holds the sync lock" };
  try {
    // Quiet-tick pre-flight (#273) — inside the lock, so the fingerprint describes a quiescent
    // tree. Only canon feeds this pass (staging is never consolidated), so canon is the only input.
    // `fingerprint` is captured BEFORE the work and recorded after it succeeds, so an exception or
    // an interrupt below leaves the previous checkpoint intact and this window is re-processed.
    let fingerprint: string | undefined;
    if (!opts.dryRun) {
      const tick = await quietTick(brainDir, "consolidate", {
        trees: [brainDir],
        params: { threshold },
      });
      if (tick.unchanged && !opts.force) {
        await confirmCheckpoint(brainDir, "consolidate", Date.now());
        return { clusters: 0, superseded: [], unchangedSince: tick.since };
      }
      fingerprint = tick.fingerprint;
    }

    const notes = await listNotes(brainDir);
    // Only supersede-able kinds, and only notes not already superseded.
    const active = notes.filter(
      (n) =>
        (n.frontmatter.kind === "memory" || n.frontmatter.kind === "decision") &&
        n.frontmatter.status !== "superseded",
    );

    const superseded: Supersession[] = [];
    let clusters = 0;
    // Dedup within a kind only — a memory and a decision are never merged.
    for (const kind of ["memory", "decision"] as const) {
      const ofKind = active.filter((n) => n.frontmatter.kind === kind);
      for (const cluster of clusterBySimilarity(ofKind, threshold)) {
        clusters += 1;
        const survivor = pickSurvivor(cluster);
        for (const dup of cluster) {
          if (dup.frontmatter.id === survivor.frontmatter.id) continue;
          if (!opts.dryRun) await supersedeNote(brainDir, dup.path, survivor.frontmatter.id);
          superseded.push({
            id: dup.frontmatter.id,
            path: dup.path,
            survivor: survivor.frontmatter.id,
          });
        }
      }
    }
    superseded.sort((a, b) => (a.id < b.id ? -1 : 1));
    // Success ⇒ advance the checkpoint. Note the fingerprint describes the tree as it was BEFORE
    // any supersession, so a pass that actually wrote something leaves canon looking "changed" and
    // the next tick runs once more. That is intended: a supersession can open up a new merge, and
    // the follow-up run settles into the quiet state.
    if (fingerprint !== undefined) {
      await recordCheckpoint(brainDir, "consolidate", fingerprint, Date.now());
    }
    return { clusters, superseded };
  } finally {
    await release();
  }
}
