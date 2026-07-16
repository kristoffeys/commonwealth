import { buildIndex, importSharedRules, regenerateDerived } from "@cmnwlth/core";
import { resolveConflictsAsSiblings, type ResolvedConflict } from "./conflict.js";
import {
  abortRebase,
  commitAllExceptSecrets,
  conflictedPaths,
  hasRemote,
  isRebasing,
  needsPush,
  pullRebase,
  push,
} from "./git.js";
import { acquireSyncLock } from "./lock.js";
import { SerialQueue } from "./queue.js";

/** A pass that did nothing (no lock, or nothing to do): every flag false, no conflicts/secrets. */
const NOOP_SUMMARY: SyncSummary = {
  committed: false,
  pulled: false,
  pushed: false,
  conflicts: [],
  secretsBlocked: [],
  skippedLocked: false,
};

/** Options for constructing a {@link SyncEngine}. */
export interface SyncEngineOptions {
  /** Existing serial queue to share (e.g. with a daemon). One is created if omitted. */
  queue?: SerialQueue;
}

/** Outcome of a single {@link SyncEngine.syncOnce} pass. */
export interface SyncSummary {
  /** A commit of local (pre-pull) changes was created. */
  committed: boolean;
  /** A pull/rebase actually ran (a remote + upstream existed). */
  pulled: boolean;
  /** A push to origin ran. */
  pushed: boolean;
  /** Same-file conflicts that were resolved as siblings this pass. */
  conflicts: ResolvedConflict[];
  /**
   * Repo-relative note paths withheld from the local commit because they contained a
   * secret (#16). They remain modified/uncommitted in the working tree for the user to fix.
   */
  secretsBlocked: string[];
  /**
   * True when this pass did nothing because another LIVE process held the cross-process sync lock
   * (#100). Distinct from a genuine no-op (nothing to sync): a lock-skip means work MAY remain, so
   * lifecycle callers can retry with backoff (ADR-0032) rather than silently defer. See
   * {@link syncOnceWithRetry}.
   */
  skippedLocked: boolean;
}

/** Safety valve so a pathological rebase can't spin forever. */
const MAX_REBASE_ROUNDS = 50;

/**
 * The testable sync core over a single brain working copy. `syncOnce` runs the full
 * cycle THROUGH a serial queue so concurrent callers (watcher, poll, CLI) never race
 * (issue #7): commit local → pull/rebase → resolve conflicts as siblings → rebuild
 * derived index → commit derived → push. Degrades gracefully with no remote configured.
 */
export class SyncEngine {
  readonly brainDir: string;
  readonly queue: SerialQueue;

  constructor(brainDir: string, opts: SyncEngineOptions = {}) {
    this.brainDir = brainDir;
    this.queue = opts.queue ?? new SerialQueue();
  }

  /** Run one full sync cycle, serialized against every other queued mutation. */
  syncOnce(): Promise<SyncSummary> {
    return this.queue.enqueue(() => this.runSyncOnce());
  }

  private async runSyncOnce(): Promise<SyncSummary> {
    const dir = this.brainDir;

    // 0a. Cross-process lock: another process (a one-shot `sync`, or a second daemon) may be
    //     mid-sync on this same repo. The in-process SerialQueue can't see it, so acquire a
    //     file lock; if a live process holds it, skip this pass rather than race its git ops
    //     (#100). The daemon/poll will sync again shortly; a one-shot defers to the running one.
    const release = await acquireSyncLock(dir);
    if (!release) return { ...NOOP_SUMMARY, skippedLocked: true };
    try {
      // 0b. Recover a rebase stranded by a previously crashed/killed pass (#100). Committing new
      //     work while mid-rebase would land it on a detached HEAD and then the pullRebase below
      //     fails. Abort first so we start from a clean branch tip with local commits intact.
      if (await isRebasing(dir)) await abortRebase(dir);
      return await this.syncLocked(dir);
    } finally {
      await release();
    }
  }

  /** The sync cycle proper, run while holding the cross-process lock (see {@link runSyncOnce}). */
  private async syncLocked(dir: string): Promise<SyncSummary> {
    // 1. Commit local changes first, so the rebase replays them onto teammates' work.
    //    Scrub secrets pre-commit (#16): note files carrying a credential are unstaged and
    //    left uncommitted, so a leaked secret is never committed or pushed.
    const { committed, secretsBlocked } = await commitAllExceptSecrets(
      dir,
      "commonwealth: sync local changes",
    );

    // 2. Pull with rebase; resolve any same-file conflicts as siblings, then finish.
    const remote = await hasRemote(dir);
    let pulled = false;
    const conflicts: ResolvedConflict[] = [];

    if (remote) {
      const { conflicts: hadConflict } = await pullRebase(dir);
      pulled = true;
      if (hadConflict) {
        // A rebase can stop on several commits in turn; resolve each round until done.
        let rounds = 0;
        while (await isRebasing(dir)) {
          if (rounds++ >= MAX_REBASE_ROUNDS) {
            throw new Error(`Rebase did not converge after ${MAX_REBASE_ROUNDS} rounds`);
          }
          const paths = await conflictedPaths(dir);
          if (paths.length === 0) break; // stopped for a non-conflict reason; loop guards it
          conflicts.push(...(await resolveConflictsAsSiblings(dir, paths)));
        }
      }
    }

    // 2b. Propagate this brain's SHARED routing rules (ADR-0024 §5) into the per-user config, so a
    //     teammate's freshly-pulled `sharedRules` take effect locally (local rules still override).
    //     Best-effort: a sync must never fail over a rule-materialization hiccup, and it is a true
    //     no-op for the common brain that shares nothing.
    try {
      await importSharedRules(dir);
    } catch {
      // non-fatal — the per-user config is untouched on any error (persistRegistry is atomic).
    }

    // 3. Rebuild derived artifacts from the (now-merged) note set.
    await buildIndex(dir);
    await regenerateDerived(dir);

    // 4. Commit derived changes (COMMONWEALTH.md / INDEX.md) if regeneration moved anything.
    //    Re-scrub: `add -A` here would otherwise re-stage a secret note left in the working
    //    tree by step 1, so route this commit through the same guard and merge the results.
    const derived = await commitAllExceptSecrets(dir, "commonwealth: regenerate derived index");
    for (const p of derived.secretsBlocked) {
      if (!secretsBlocked.includes(p)) secretsBlocked.push(p);
    }

    // 5. Push only when the branch is actually ahead of its upstream — so an idle poll
    //    doesn't hit the remote every interval, while still pushing commits made outside
    //    the engine (e.g. a raw `git commit`) or left unpushed by an earlier failure.
    let pushed = false;
    if (remote && (await needsPush(dir))) {
      await push(dir);
      pushed = true;
    }

    return { committed, pulled, pushed, conflicts, secretsBlocked, skippedLocked: false };
  }
}

/** Options for {@link syncOnceWithRetry}. */
export interface SyncRetryOptions {
  /** Maximum number of `syncOnce` attempts (default 6). Bounded so a wedged peer can't spin forever. */
  attempts?: number;
  /** Base backoff in ms between lock-contended attempts; grows linearly per attempt (default 75). */
  backoffMs?: number;
  /** Called before each retry (attempt index ≥ 1), for tests/observability. */
  onRetry?: (attempt: number) => void;
  /** Injectable sleep (tests). Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

/** Outcome of {@link syncOnceWithRetry}: the last pass summary plus how many attempts it took. */
export interface SyncRetryResult {
  summary: SyncSummary;
  /** Total `syncOnce` attempts made (≥ 1). */
  attempts: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run {@link SyncEngine.syncOnce}, RETRYING with bounded linear backoff while a pass is skipped
 * because another live process holds the cross-process lock (ADR-0032). This is the discipline the
 * daemonless lifecycle hooks use: when two session-ends fire on one brain, the winner commits and
 * pushes while the loser retries until the lock frees and then flushes its own changes — so BOTH
 * teammates' notes land in one round rather than the loser deferring to its next SessionStart. The
 * retry budget is bounded (`attempts`), so a genuinely wedged peer never causes an unbounded spin;
 * if the budget is exhausted while still locked, the loser defers to the next SessionStart debt
 * flush (the returned summary still carries `skippedLocked: true`). A non-lock no-op or any real
 * work resolves immediately. Never throws beyond what `syncOnce` itself throws.
 */
export async function syncOnceWithRetry(
  engine: SyncEngine,
  opts: SyncRetryOptions = {},
): Promise<SyncRetryResult> {
  const attempts = Math.max(1, opts.attempts ?? 6);
  const backoffMs = Math.max(0, opts.backoffMs ?? 75);
  const sleep = opts.sleep ?? defaultSleep;
  let summary = await engine.syncOnce();
  let made = 1;
  while (summary.skippedLocked && made < attempts) {
    opts.onRetry?.(made);
    await sleep(backoffMs * made);
    summary = await engine.syncOnce();
    made += 1;
  }
  return { summary, attempts: made };
}
