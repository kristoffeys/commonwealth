import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findGitRepos } from "../src/discover.js";

let base: string;

/** Create a directory tree and mark selected dirs as git repos (empty `.git` dir). */
async function scaffold(root: string): Promise<void> {
  const mk = (p: string): Promise<string | undefined> =>
    fs.mkdir(path.join(root, p), { recursive: true });
  const gitmark = (p: string): Promise<string | undefined> =>
    fs.mkdir(path.join(root, p, ".git"), { recursive: true });

  // repos at depth 1
  await mk("alpha");
  await gitmark("alpha");
  await mk("beta");
  await gitmark("beta");
  // a repo at depth 2
  await mk("group/gamma");
  await gitmark("group/gamma");
  // a repo too deep (depth 3) — must be excluded at default depth 2
  await mk("group/nested/delta");
  await gitmark("group/nested/delta");
  // node_modules with a repo inside — must be skipped
  await mk("node_modules/pkg");
  await gitmark("node_modules/pkg");
  // a dotdir with a repo inside — must be skipped
  await mk(".cache/hidden");
  await gitmark(".cache/hidden");
  // a plain non-repo dir
  await mk("plain");
}

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cw-discover-")));
  await scaffold(base);
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe("findGitRepos", () => {
  it("finds repos up to the default depth (2), sorted, skipping node_modules + dotdirs", async () => {
    const repos = await findGitRepos(base);
    expect(repos).toEqual([
      path.join(base, "alpha"),
      path.join(base, "beta"),
      path.join(base, "group", "gamma"),
    ]);
  });

  it("respects maxDepth: depth 1 excludes the depth-2 repo", async () => {
    const repos = await findGitRepos(base, { maxDepth: 1 });
    expect(repos).toEqual([path.join(base, "alpha"), path.join(base, "beta")]);
  });

  it("deeper maxDepth reaches the depth-3 repo", async () => {
    const repos = await findGitRepos(base, { maxDepth: 3 });
    expect(repos).toContain(path.join(base, "group", "nested", "delta"));
  });

  it("detects baseDir itself as a repo (depth 0)", async () => {
    await fs.mkdir(path.join(base, ".git"), { recursive: true });
    const repos = await findGitRepos(base, { maxDepth: 0 });
    expect(repos).toEqual([base]);
  });

  it("never throws on an unreadable / missing base dir", async () => {
    await expect(findGitRepos(path.join(base, "does-not-exist"))).resolves.toEqual([]);
  });
});
