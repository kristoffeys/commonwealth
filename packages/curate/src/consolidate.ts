import { promises as fs } from "node:fs";
import path from "node:path";
import {
  acquireSyncLock,
  confirmCheckpoint,
  isFeatureEnabled,
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

// ---------------------------------------------------------------------------------------------
// Periodic gate (ADR-0046, #319): decide WHEN a background SessionEnd worker should even attempt
// a consolidation pass, mirroring `autoDream`'s "at most once per 24h AND ≥5 sessions since the
// last one" gating. This is deliberately separate from `consolidateCanon`'s own #273 quiet-tick
// checkpoint: the checkpoint's `ranAt` only advances when a full pass actually runs over a CHANGED
// tree, so a brain that's been quiet for weeks would never re-arm a 24h/5-session gate built on
// that file (see ADR-0046's alternatives). This file answers "did we bother to CHECK recently
// enough", independent of whether checking found anything to do.

/** Default cooldown: at most one consolidation attempt per 24h (matches `autoDream`). */
export const DEFAULT_GATE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** Default minimum sessions since the last check before another attempt is due. */
export const DEFAULT_GATE_MIN_SESSIONS = 5;

/** Where the gate's derived, disposable state lives — same `index/` area as checkpoints/receipts. */
function gatePath(brainDir: string): string {
  return path.join(brainDir, "index", "consolidate-gate.json");
}

interface GateState {
  sessionsSinceCheck: number;
  lastCheckedAt: string | null;
}

const EMPTY_GATE_STATE: GateState = { sessionsSinceCheck: 0, lastCheckedAt: null };

async function readGateState(brainDir: string): Promise<GateState> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(gatePath(brainDir), "utf8"));
    if (!parsed || typeof parsed !== "object") return { ...EMPTY_GATE_STATE };
    const s = parsed as Partial<GateState>;
    return {
      sessionsSinceCheck: typeof s.sessionsSinceCheck === "number" ? s.sessionsSinceCheck : 0,
      lastCheckedAt: typeof s.lastCheckedAt === "string" ? s.lastCheckedAt : null,
    };
  } catch {
    // Absent/unreadable/malformed ⇒ a fresh gate. Failing toward "not due yet" (0 sessions) rather
    // than toward "always due" — a corrupted gate file costs a few extra sessions of delay, never
    // a canon mutation nobody asked for.
    return { ...EMPTY_GATE_STATE };
  }
}

async function writeGateState(brainDir: string, state: GateState): Promise<void> {
  try {
    const file = gatePath(brainDir);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state), "utf8");
    await fs.rename(tmp, file);
  } catch {
    // Best-effort — see the module-level note: losing gate state costs one mistimed run, never a
    // broken session and never a note.
  }
}

/**
 * Record that a session ended in `brainDir` (regardless of whether it captured anything), for the
 * periodic-consolidation gate's session-count leg. Call this once per qualifying SessionEnd, BEFORE
 * checking {@link isConsolidationDue}, so the session that tips the count over the threshold is
 * itself the one that triggers the pass — matching `autoDream`'s "≥5 sessions since" phrasing.
 * Best-effort; never throws.
 */
export async function noteConsolidationSession(brainDir: string): Promise<void> {
  const state = await readGateState(brainDir);
  await writeGateState(brainDir, {
    ...state,
    sessionsSinceCheck: state.sessionsSinceCheck + 1,
  });
}

/** Gate options (`autoDream`-matching defaults; not brain-config-tunable in v1 — see ADR-0046). */
export interface ConsolidationGateOptions {
  cooldownMs?: number;
  minSessions?: number;
  now?: number;
}

/**
 * Whether a periodic consolidation attempt is due right now: at least `minSessions` sessions have
 * ended since the last check AND at least `cooldownMs` has elapsed since the last check (or there
 * has never been one). Pure given the gate state; does not mutate it — see
 * {@link recordConsolidationCheck} for advancing the gate after an attempt.
 */
export async function isConsolidationDue(
  brainDir: string,
  opts: ConsolidationGateOptions = {},
): Promise<boolean> {
  const cooldownMs = opts.cooldownMs ?? DEFAULT_GATE_COOLDOWN_MS;
  const minSessions = opts.minSessions ?? DEFAULT_GATE_MIN_SESSIONS;
  const now = opts.now ?? Date.now();
  const state = await readGateState(brainDir);
  if (state.sessionsSinceCheck < minSessions) return false;
  if (state.lastCheckedAt === null) return true;
  const last = Date.parse(state.lastCheckedAt);
  if (Number.isNaN(last)) return true; // malformed timestamp ⇒ fail toward doing the check
  return now - last >= cooldownMs;
}

/**
 * Advance the gate after a consolidation attempt: reset the session counter and stamp the check
 * time, whether or not the attempt found anything to do (a quiet brain must not re-scan every
 * qualifying session forever — see the module docstring). Best-effort; never throws.
 */
export async function recordConsolidationCheck(brainDir: string, now = Date.now()): Promise<void> {
  await writeGateState(brainDir, {
    sessionsSinceCheck: 0,
    lastCheckedAt: new Date(now).toISOString(),
  });
}

/** Outcome of one {@link maybeConsolidate} call. */
export interface PeriodicConsolidateOutcome {
  /** Whether the gate allowed an attempt this call (false ⇒ still cooling down / too few sessions). */
  ran: boolean;
  /**
   * Set when `ran` and `autoPromote` was off: `consolidateCanon` ran in dry-run mode, so any
   * clusters it found were reported, not applied. The caller (SessionEnd) is expected to surface
   * this via a receipt pointing at `commonwealth consolidate` for a human to apply.
   */
  pending?: boolean;
  /** The underlying pass result, present whenever `ran` is true. */
  result?: ConsolidationResult;
}

/**
 * The SessionEnd entry point (ADR-0046, #319): record this session against the gate, and — only
 * when the gate says it's due — run `consolidateCanon`, respecting the brain's `autoPromote` flag
 * (apply for real when on; dry-run/report when off). Never throws: a gate-state or consolidation
 * failure must never break a session, so every failure mode here collapses to `{ ran: false }`.
 */
export async function maybeConsolidate(
  brainDir: string,
  opts: ConsolidationGateOptions & { threshold?: number } = {},
): Promise<PeriodicConsolidateOutcome> {
  try {
    if (!(await isFeatureEnabled(brainDir, "autoConsolidate"))) return { ran: false };
    await noteConsolidationSession(brainDir);
    if (!(await isConsolidationDue(brainDir, opts))) return { ran: false };

    const autoPromote = await isFeatureEnabled(brainDir, "autoPromote");
    // The gate advances on every ATTEMPT, success or not — see the module docstring — so record it
    // before running the pass, not after, in case the pass throws.
    await recordConsolidationCheck(brainDir, opts.now ?? Date.now());

    const result = await consolidateCanon(brainDir, {
      threshold: opts.threshold,
      dryRun: !autoPromote,
    });
    return { ran: true, pending: !autoPromote && result.clusters > 0, result };
  } catch {
    return { ran: false };
  }
}
