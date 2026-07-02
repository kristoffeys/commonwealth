import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const pexec = promisify(execFile);

/**
 * Resolve a stable project identity for `cwd` — the value stamped as a note's frontmatter
 * `source` so a shared brain can group/filter notes by originating project (ADR-0015).
 *
 * Order: the nearest ancestor git repo's `origin` remote, slugified to `owner/repo` → else
 * that repo root's basename → else the basename of `cwd`. Best-effort and never throws: git
 * being absent/erroring degrades to the basename. Returns `null` only for an empty input.
 */
export async function resolveProjectSource(cwd: string): Promise<string | null> {
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  const start = path.resolve(cwd);
  const root = findGitRoot(start);
  if (root) {
    const remote = await originUrl(root);
    const slug = remote ? slugFromRemote(remote) : null;
    return slug ?? path.basename(root);
  }
  return path.basename(start);
}

/** Nearest ancestor of `startDir` (inclusive) containing a `.git`, or null if none. */
function findGitRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** `git -C <root> config --get remote.origin.url`, or null if unset/unavailable. */
async function originUrl(root: string): Promise<string | null> {
  try {
    const { stdout } = await pexec("git", ["-C", root, "config", "--get", "remote.origin.url"]);
    const url = stdout.trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

/**
 * Reduce a git remote URL to a stable `owner/repo` identity (or bare `repo` when there is no
 * owner segment). Handles `git@host:owner/repo.git`, `https://host/owner/repo(.git)`, and
 * `ssh://host/owner/repo`. Returns null when nothing usable can be extracted.
 */
export function slugFromRemote(remote: string): string | null {
  // Normalize scp-style `git@host:owner/repo` to a slash-path, then drop scheme/host.
  let s = remote.trim().replace(/\.git$/i, "");
  s = s.replace(/^[a-z]+:\/\//i, "").replace(/^[^@]+@/, ""); // strip scheme and user@
  s = s.replace(/^[^/:]+[:/]/, ""); // strip host + first separator (: for scp, / for url)
  const parts = s.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  return parts.slice(-2).join("/");
}
