import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const pexec = promisify(execFile);

/**
 * Clone-on-demand for a mapped-but-missing brain (ADR-0019). A teammate whose registry maps a
 * project to a brain they haven't checked out yet should just start working — the daemon (or a
 * one-shot sync) materializes the brain from its recorded remote on first use, under the user's
 * own git identity. That clone succeeding or failing IS the access-control check: git host repo
 * permissions are the ACL; we build none (ADR-0019 §1).
 *
 * Race-safe without a pre-existing lock (the brain dir doesn't exist yet, so the ADR-0006 sync
 * lock has nowhere to live): we clone into a unique temp sibling and then ATOMICALLY rename it into
 * place. If another process won the race, the rename onto its non-empty dir fails and we discard
 * our temp clone. Never throws for the "already there" or "someone else won" cases.
 */

/** Outcome of {@link ensureBrainCloned}. */
export type CloneOutcome =
  | { status: "exists" } // the brain was already present locally
  | { status: "cloned" } // we cloned it into place
  | { status: "no-remote" } // missing locally and no remote to clone from
  | { status: "failed"; error: string }; // clone attempt failed (offline, auth, bad URL…)

/** True when `dir` exists and is a directory. */
async function isDir(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Ensure `brainDir` exists locally, cloning it from `remote` if not. No-op (`"exists"`) when the
 * directory is already present; `"no-remote"` when it's missing and `remote` is empty/undefined.
 * The clone goes to a temp sibling then renames into place, so concurrent callers can't corrupt a
 * half-clone — the loser cleans up and reports `"exists"`. Git's own error text is surfaced on
 * failure (auth/offline/bad-URL), never swallowed.
 */
export async function ensureBrainCloned(
  brainDir: string,
  remote: string | undefined,
): Promise<CloneOutcome> {
  const dir = path.resolve(brainDir);
  if (await isDir(dir)) return { status: "exists" };
  if (!remote || remote.trim().length === 0) return { status: "no-remote" };

  await fs.mkdir(path.dirname(dir), { recursive: true });
  const tmp = `${dir}.clone-${process.pid}-${Date.now()}`;
  try {
    await pexec("git", ["clone", "--quiet", remote, tmp]);
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true });
    // A concurrent clone may have finished while ours was running.
    if (await isDir(dir)) return { status: "exists" };
    const msg =
      (err as { stderr?: string; message?: string }).stderr?.trim() || (err as Error).message;
    return { status: "failed", error: msg };
  }

  try {
    await fs.rename(tmp, dir);
    return { status: "cloned" };
  } catch (err) {
    // Someone else won the race (target now exists / non-empty) → discard our clone.
    await fs.rm(tmp, { recursive: true, force: true });
    const code = (err as NodeJS.ErrnoException).code;
    if ((code === "ENOTEMPTY" || code === "EEXIST" || code === "EPERM") && (await isDir(dir))) {
      return { status: "exists" };
    }
    if (await isDir(dir)) return { status: "exists" };
    return { status: "failed", error: (err as Error).message };
  }
}
