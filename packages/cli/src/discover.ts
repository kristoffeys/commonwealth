import { promises as fs } from "node:fs";
import path from "node:path";

/** Options for {@link findGitRepos}. */
export interface FindGitReposOptions {
  /** How many directory levels below `baseDir` to descend (default 2). `0` = only `baseDir`. */
  maxDepth?: number;
}

/**
 * Discover git repositories under `baseDir`: every directory that directly contains a `.git`
 * entry (a file or directory), scanning up to `maxDepth` levels deep. Skips `node_modules` and
 * any dot-directory (e.g. `.git`, `.cache`) so it never descends into vendored or hidden trees.
 *
 * Never throws: an unreadable directory is simply skipped. Results are absolute, de-duped, and
 * sorted lexicographically for deterministic output.
 *
 * @param baseDir Directory to scan from.
 * @param opts Optional depth cap ({@link FindGitReposOptions}).
 * @returns Absolute paths of directories that are git repos, sorted and de-duped.
 */
export async function findGitRepos(
  baseDir: string,
  opts: FindGitReposOptions = {},
): Promise<string[]> {
  const maxDepth = opts.maxDepth ?? 2;
  const root = path.resolve(baseDir);
  const found = new Set<string>();

  const visit = async (dir: string, depth: number): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir -> skip
    }

    if (entries.some((e) => e.name === ".git")) {
      found.add(dir);
    }

    if (depth >= maxDepth) return;

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name === "node_modules") continue;
      if (entry.name.startsWith(".")) continue;
      const child = path.join(dir, entry.name);
      try {
        const stat = await fs.stat(child);
        if (!stat.isDirectory()) continue;
      } catch {
        continue; // dangling symlink or unreadable -> skip
      }
      await visit(child, depth + 1);
    }
  };

  await visit(root, 0);
  return [...found].sort();
}
