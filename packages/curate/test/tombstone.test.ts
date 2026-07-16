import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { initBrain } from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addTombstone,
  graduationClusterKey,
  loadTombstonedKeys,
  tombstoneDir,
} from "../src/tombstone.js";

// Reject-tombstone store (#172). These are the store-shape tests that guard the concurrency
// doctrine (ADR-0003, one fact per file): a per-file directory, not a shared JSON blob.

const run = promisify(execFile);

let org: string;

beforeEach(async () => {
  org = await fs.mkdtemp(path.join(tmpdir(), "cw-tombstone-"));
  await initBrain(org, { name: "org" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(org, { recursive: true, force: true });
});

describe("tombstone store (#172)", () => {
  it("two teammates rejecting different clusters union-merge with zero git conflict", async () => {
    // initBrain leaves `org` a git repo with an initial commit; give it a committer identity so
    // the branch commits below succeed on a bare CI runner.
    const git = (...args: string[]): Promise<{ stdout: string }> => run("git", args, { cwd: org });
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();

    const refsA = ["acme/aaaaaaaaaaaa", "beta/bbbbbbbbbbbb"];
    const refsB = ["acme/cccccccccccc", "gamma/dddddddddddd"];
    const keyA = graduationClusterKey(refsA);
    const keyB = graduationClusterKey(refsB);

    // Branch A rejects cluster A.
    await git("checkout", "-q", "-b", "reviewer-a");
    await addTombstone(org, { refs: refsA, title: "Cluster A", kind: "memory" });
    await git("add", "-A");
    await git("commit", "-q", "-m", "reject A");

    // Branch B (from the common base) rejects a DIFFERENT cluster B.
    await git("checkout", "-q", "-b", "reviewer-b", base);
    await addTombstone(org, { refs: refsB, title: "Cluster B", kind: "memory" });
    await git("add", "-A");
    await git("commit", "-q", "-m", "reject B");

    // Merging A into B is a clean add/add of distinct files — no conflict.
    await expect(git("merge", "--no-edit", "reviewer-a")).resolves.toBeTruthy();

    // Both tombstones survive the merge.
    const keys = await loadTombstonedKeys(org);
    expect(keys.has(keyA)).toBe(true);
    expect(keys.has(keyB)).toBe(true);
    expect(keys.size).toBe(2);
  });

  it("a single corrupt tombstone file is skipped with a breadcrumb; the others still load", async () => {
    const refs = ["acme/eeeeeeeeeeee", "beta/ffffffffffff"];
    const key = await addTombstone(org, { refs, title: "Good", kind: "memory" });

    // Simulate a torn file (e.g. a conflicted or truncated write).
    await fs.writeFile(
      path.join(tombstoneDir(org), "deadbeefdeadbeef.json"),
      "{ not valid json",
      "utf8",
    );

    const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const keys = await loadTombstonedKeys(org);

    expect(keys.has(key)).toBe(true); // the good tombstone still loads
    expect(keys.has("deadbeefdeadbeef")).toBe(false); // the corrupt one is skipped
    expect(keys.size).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/skipping unreadable tombstone/));

    // A subsequent add for a NEW key is unaffected by the corrupt sibling.
    const other = await addTombstone(org, {
      refs: ["acme/gggggggggggg", "beta/hhhhhhhhhhhh"],
      title: "Other",
      kind: "memory",
    });
    const after = await loadTombstonedKeys(org);
    expect(after.has(other)).toBe(true);
  });

  it("re-rejecting the same cluster is an idempotent no-op that never rewrites the file", async () => {
    const refs = ["acme/iiiiiiiiiiii", "beta/jjjjjjjjjjjj"];
    const key1 = await addTombstone(org, { refs, title: "First", kind: "memory" });
    const file = path.join(tombstoneDir(org), `${key1}.json`);
    const first = JSON.parse(await fs.readFile(file, "utf8")) as { title: string };
    expect(first.title).toBe("First");

    // Re-reject with a different title (and refs in a different order) — same key, no rewrite.
    const key2 = await addTombstone(org, {
      refs: [...refs].reverse(),
      title: "Second",
      kind: "memory",
    });
    expect(key2).toBe(key1);
    const second = JSON.parse(await fs.readFile(file, "utf8")) as { title: string };
    expect(second.title).toBe("First"); // untouched
    expect((await loadTombstonedKeys(org)).size).toBe(1);
  });
});
