import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureBrainCloned } from "../src/clone.js";
import { initBrain } from "../src/scaffold.js";

/**
 * Clone-on-demand (ADR-0019). `initBrain` gives us a real local git repo to act as the "remote";
 * `git clone` from a local path exercises the whole path with no network.
 */
describe("ensureBrainCloned", () => {
  let root: string;
  let source: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cw-clone-")));
    source = path.join(root, "source-brain");
    await initBrain(source, { name: "source" }); // a real git repo with a commit
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("no-ops when the brain already exists", async () => {
    const target = path.join(root, "already");
    await fs.mkdir(target, { recursive: true });
    expect(await ensureBrainCloned(target, source)).toEqual({ status: "exists" });
  });

  it("reports no-remote when the brain is missing and no remote is given", async () => {
    const target = path.join(root, "missing");
    expect(await ensureBrainCloned(target, undefined)).toEqual({ status: "no-remote" });
    expect(await ensureBrainCloned(target, "")).toEqual({ status: "no-remote" });
    // It must not have created the dir.
    await expect(fs.stat(target)).rejects.toThrow();
  });

  it("clones a missing brain from its remote", async () => {
    const target = path.join(root, "cloned");
    expect(await ensureBrainCloned(target, source)).toEqual({ status: "cloned" });
    // The clone is a real working copy with the source's content + a .git.
    expect((await fs.stat(path.join(target, ".git"))).isDirectory()).toBe(true);
    expect((await fs.stat(path.join(target, "COMMONWEALTH.md"))).isFile()).toBe(true);
  });

  it("is idempotent — a second call sees the brain already present", async () => {
    const target = path.join(root, "twice");
    expect((await ensureBrainCloned(target, source)).status).toBe("cloned");
    expect((await ensureBrainCloned(target, source)).status).toBe("exists");
  });

  it("returns failed (with git's error) for an unreachable remote", async () => {
    const target = path.join(root, "bad");
    const result = await ensureBrainCloned(target, path.join(root, "does-not-exist"));
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.error.length).toBeGreaterThan(0);
    // A failed clone leaves no partial target behind.
    await expect(fs.stat(target)).rejects.toThrow();
  });

  it("survives a concurrent race — both callers converge, neither corrupts", async () => {
    const target = path.join(root, "raced");
    const [a, b] = await Promise.all([
      ensureBrainCloned(target, source),
      ensureBrainCloned(target, source),
    ]);
    // Exactly one cloned; the other saw it already there. Never two "cloned", never a failure.
    expect([a.status, b.status].sort()).toEqual(["cloned", "exists"]);
    expect((await fs.stat(path.join(target, ".git"))).isDirectory()).toBe(true);
  });
});
