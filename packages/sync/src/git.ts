import { promises as fs } from "node:fs";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";

/**
 * Open a simple-git handle bound to a working directory. `core.editor=true` is injected
 * into every invocation (via `-c`) so non-interactive steps that would otherwise open an
 * editor — notably `rebase --continue` recording a resolution commit — never block.
 */
export function openRepo(dir: string): SimpleGit {
  return simpleGit(dir, {
    config: ["core.editor=true"],
    // core.editor is on simple-git's block list; we set it to the non-interactive `true`
    // binary purely so unattended `rebase --continue` can record its commit.
    unsafe: { allowUnsafeEditor: true },
  });
}

/** True if the working tree has staged, unstaged, or untracked changes. */
export async function hasChanges(dir: string): Promise<boolean> {
  const status = await openRepo(dir).status();
  return !status.isClean();
}

/**
 * Stage everything and commit — but only if there is something to commit. Returns true
 * if a commit was actually created, false when the tree was already clean (so callers
 * can report whether local work landed without probing git themselves).
 */
export async function commitAll(dir: string, message: string): Promise<boolean> {
  const git = openRepo(dir);
  await git.add(["-A"]);
  const status = await git.status();
  if (status.isClean()) return false;
  await git.commit(message);
  return true;
}

/** The current branch name, or null if detached / no commits yet. */
export async function currentBranch(dir: string): Promise<string | null> {
  return (await openRepo(dir).status()).current;
}

/** True if the repo has an `origin` remote configured. */
export async function hasRemote(dir: string): Promise<boolean> {
  const remotes = await openRepo(dir).getRemotes();
  return remotes.some((r) => r.name === "origin");
}

/** Repo-relative paths that are currently in a merge/rebase conflict state. */
export async function conflictedPaths(dir: string): Promise<string[]> {
  return (await openRepo(dir).status()).conflicted;
}

/**
 * Fetch and rebase the current branch onto its upstream (`--autostash` so local WIP is
 * preserved). Returns `{ conflicts }` — true when the rebase stopped on a conflict that
 * the caller must resolve. Other rebase failures are re-thrown.
 *
 * No-ops (returns `{ conflicts: false }`) when there is no `origin` remote or the branch
 * has no upstream tracking ref, so a local-only brain syncs without error.
 */
export async function pullRebase(dir: string): Promise<{ conflicts: boolean }> {
  const git = openRepo(dir);
  if (!(await hasRemote(dir))) return { conflicts: false };

  const status = await git.status();
  const branch = status.current;
  if (!branch) return { conflicts: false };

  await git.fetch("origin");

  // Determine the upstream: prefer the tracked ref, else fall back to origin/<branch>
  // if the remote actually has it (first push may not have set tracking yet).
  let upstream = status.tracking;
  if (!upstream) {
    const remoteBranches = await git.branch(["-r"]);
    const candidate = `origin/${branch}`;
    if (remoteBranches.all.includes(candidate)) upstream = candidate;
  }
  if (!upstream) return { conflicts: false };

  try {
    await git.raw(["rebase", "--autostash", upstream]);
    return { conflicts: false };
  } catch (err) {
    // A conflict leaves us mid-rebase with entries in `conflicted`; anything else is fatal.
    const conflicted = (await git.status()).conflicted;
    if (conflicted.length > 0) return { conflicts: true };
    throw err;
  }
}

/** True if a rebase is currently in progress (a `.git/rebase-*` dir exists). */
export async function isRebasing(dir: string): Promise<boolean> {
  const gitDir = (await openRepo(dir).revparse(["--git-dir"])).trim();
  const base = path.isAbsolute(gitDir) ? gitDir : path.join(dir, gitDir);
  for (const name of ["rebase-merge", "rebase-apply"]) {
    try {
      await fs.access(path.join(base, name));
      return true;
    } catch {
      // not present — check the next
    }
  }
  return false;
}

/**
 * True when there is something to push: no upstream yet (first push, to set tracking) or
 * the branch is ahead of its upstream. Lets callers skip idle pushes without missing
 * commits made outside the engine (e.g. a raw `git commit`). Assumes a recent fetch.
 */
export async function needsPush(dir: string): Promise<boolean> {
  if (!(await hasRemote(dir))) return false;
  const status = await openRepo(dir).status();
  if (!status.current) return false;
  if (!status.tracking) return true; // upstream not set yet → push to establish it
  return status.ahead > 0;
}

/** Push the current branch to `origin`, setting upstream so future pulls track it. */
export async function push(dir: string): Promise<void> {
  const git = openRepo(dir);
  if (!(await hasRemote(dir))) return;
  const branch = (await git.status()).current;
  if (!branch) return;
  await git.push(["-u", "origin", branch]);
}
