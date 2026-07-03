import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * A cross-PROCESS advisory lock for a brain's git operations (#100). The `SerialQueue`
 * serializes syncs WITHIN one process, but a one-shot `commonwealth sync` (or a second daemon)
 * runs in a DIFFERENT process with its own queue — nothing stopped them from interleaving
 * `git commit`/`rebase`/`push` on the same repo, racing git's own `index.lock` and corrupting an
 * in-progress rebase. This lock closes that gap: at most one process runs a sync pass at a time.
 *
 * The lock is a file at `.commonwealth/sync.lock` holding the owner pid, acquired via an atomic
 * exclusive create (`wx`). A lock whose owner process is dead is stale and reclaimed, so a crash
 * never wedges syncing forever.
 */
const LOCK_REL = path.join(".commonwealth", "sync.lock");

function lockPath(brainDir: string): string {
  return path.join(brainDir, LOCK_REL);
}

/** True if `pid` names a live process (signal 0 is an existence check, sends nothing). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // ESRCH (no such process) or EPERM — treat as gone
  }
}

/** Read the owner pid recorded in the lock file, or null if missing/garbage. */
async function readOwner(file: string): Promise<number | null> {
  try {
    const pid = Number.parseInt((await fs.readFile(file, "utf8")).trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Try to acquire the sync lock for `brainDir`. Returns a `release` function on success, or
 * `null` when another LIVE process currently holds it (the caller should skip this pass). A
 * stale lock (dead owner, or unreadable) is reclaimed and acquisition retried once. Never throws
 * for the contended case; genuine IO errors propagate.
 */
export async function acquireSyncLock(brainDir: string): Promise<(() => Promise<void>) | null> {
  const file = lockPath(brainDir);
  await fs.mkdir(path.dirname(file), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await fs.open(file, "wx"); // atomic: fails if the lock already exists
      try {
        await fh.write(`${process.pid}\n`);
      } finally {
        await fh.close();
      }
      return async () => {
        await fs.rm(file, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const owner = await readOwner(file);
      if (owner !== null && isAlive(owner)) return null; // held by a live process
      // Stale (dead owner) or unreadable → reclaim and retry once.
      await fs.rm(file, { force: true });
    }
  }
  return null;
}
