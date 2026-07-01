import { buildIndex, regenerateDerived } from "@commons/core";
import { resolveConflictsAsSiblings, type ResolvedConflict } from "./conflict.js";
import {
  commitAllExceptSecrets,
  conflictedPaths,
  hasRemote,
  isRebasing,
  needsPush,
  pullRebase,
  push,
} from "./git.js";
import { SerialQueue } from "./queue.js";

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

    // 1. Commit local changes first, so the rebase replays them onto teammates' work.
    //    Scrub secrets pre-commit (#16): note files carrying a credential are unstaged and
    //    left uncommitted, so a leaked secret is never committed or pushed.
    const { committed, secretsBlocked } = await commitAllExceptSecrets(
      dir,
      "commons: sync local changes",
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

    // 3. Rebuild derived artifacts from the (now-merged) note set.
    await buildIndex(dir);
    await regenerateDerived(dir);

    // 4. Commit derived changes (COMMONS.md / INDEX.md) if regeneration moved anything.
    //    Re-scrub: `add -A` here would otherwise re-stage a secret note left in the working
    //    tree by step 1, so route this commit through the same guard and merge the results.
    const derived = await commitAllExceptSecrets(dir, "commons: regenerate derived index");
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

    return { committed, pulled, pushed, conflicts, secretsBlocked };
  }
}
