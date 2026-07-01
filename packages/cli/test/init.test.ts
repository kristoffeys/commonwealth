import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NewNoteInput } from "@commonwealth/core";
import { describe, expect, it, vi } from "vitest";
import { findRepoRoot, runInit, type InitBySource, type InitDeps } from "../src/init.js";

const NOTE: NewNoteInput = { kind: "memory", title: "t", body: "b" };

/** A candidate list of the given length. */
function candidates(n: number): NewNoteInput[] {
  return Array.from({ length: n }, (_, i) => ({ ...NOTE, title: `t${i}` }));
}

const ZERO_SOURCE: InitBySource = { adr: 0, git: 0, config: 0 };

/** Build injectable deps with vitest spies; override any piece per test. */
function makeDeps(over: Partial<InitDeps> = {}): InitDeps {
  return {
    gather: vi.fn(async () => ({ candidates: [], bySource: ZERO_SOURCE })),
    resolveBrain: vi.fn(async () => null),
    createBrain: vi.fn(async () => {}),
    registerBrain: vi.fn(async () => {}),
    stage: vi.fn(async (_dir, c) => ({ captured: c.length })),
    confirm: vi.fn(async () => true),
    log: vi.fn(),
    ...over,
  };
}

describe("runInit", () => {
  it("NEW: creates brain, registers mapping, stages the gathered candidates on confirm", async () => {
    const two = candidates(2);
    const deps = makeDeps({
      resolveBrain: vi.fn(async () => null),
      gather: vi.fn(async () => ({ candidates: two, bySource: { adr: 1, git: 1, config: 0 } })),
      confirm: vi.fn(async () => true),
    });

    const result = await runInit("/repo", { brain: "/b" }, deps);

    expect(deps.createBrain).toHaveBeenCalledTimes(1);
    expect(deps.registerBrain).toHaveBeenCalledTimes(1);
    expect(deps.stage).toHaveBeenCalledWith("/b", two);
    expect(result.mode).toBe("new");
    expect(result.staged).toBe(2);
    expect(result.gathered).toBe(2);
  });

  it("DECLINE: skips staging but still creates brain + registers mapping", async () => {
    const two = candidates(2);
    const deps = makeDeps({
      gather: vi.fn(async () => ({ candidates: two, bySource: ZERO_SOURCE })),
      confirm: vi.fn(async () => false),
    });

    const result = await runInit("/repo", { brain: "/b" }, deps);

    expect(deps.stage).not.toHaveBeenCalled();
    expect(deps.createBrain).toHaveBeenCalledTimes(1);
    expect(deps.registerBrain).toHaveBeenCalledWith("/repo", "/b");
    expect(result.mode).toBe("skipped");
    expect(result.staged).toBe(0);
    expect(result.gathered).toBe(2);
  });

  it("--yes: never prompts, stages directly", async () => {
    const three = candidates(3);
    const deps = makeDeps({
      gather: vi.fn(async () => ({ candidates: three, bySource: ZERO_SOURCE })),
    });

    const result = await runInit("/repo", { brain: "/b", yes: true }, deps);

    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.stage).toHaveBeenCalledWith("/b", three);
    expect(result.mode).toBe("new");
    expect(result.staged).toBe(3);
  });

  it("JOIN: mounts an existing brain without creating, gathering, or staging", async () => {
    const deps = makeDeps({
      resolveBrain: vi.fn(async () => "/x/brain"),
    });

    const result = await runInit("/repo", {}, deps);

    expect(deps.createBrain).not.toHaveBeenCalled();
    expect(deps.gather).not.toHaveBeenCalled();
    expect(deps.stage).not.toHaveBeenCalled();
    expect(deps.registerBrain).toHaveBeenCalledWith(findRepoRoot("/repo"), "/x/brain");
    expect(result.mode).toBe("join");
    expect(result.brainDir).toBe("/x/brain");
  });

  it("seed=false: creates brain + registers mapping but skips gathering and staging", async () => {
    const deps = makeDeps({
      gather: vi.fn(async () => ({ candidates: candidates(3), bySource: ZERO_SOURCE })),
    });

    const result = await runInit("/repo", { brain: "/b", seed: false }, deps);

    expect(deps.createBrain).toHaveBeenCalledTimes(1);
    expect(deps.registerBrain).toHaveBeenCalledWith("/repo", "/b");
    expect(deps.gather).not.toHaveBeenCalled();
    expect(deps.stage).not.toHaveBeenCalled();
    expect(result.mode).toBe("skipped");
    expect(result.staged).toBe(0);
    expect(result.gathered).toBe(0);
  });

  it("--reseed: ignores an existing brain and takes the NEW path", async () => {
    const one = candidates(1);
    const deps = makeDeps({
      resolveBrain: vi.fn(async () => "/x/brain"),
      gather: vi.fn(async () => ({ candidates: one, bySource: ZERO_SOURCE })),
    });

    const result = await runInit("/repo", { brain: "/b", reseed: true, yes: true }, deps);

    expect(deps.createBrain).toHaveBeenCalledTimes(1);
    expect(deps.stage).toHaveBeenCalledWith("/b", one);
    expect(result.mode).toBe("new");
  });

  it("scopes to the invocation dir, not a climbed parent git root (#61)", async () => {
    // A parent that IS a git repo, with a child folder that is NOT its own repo.
    const parent = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-cli-scope-")),
    );
    try {
      execFileSync("git", ["init", "-q", parent], { stdio: "pipe" });
      const child = path.join(parent, "subproject");
      await fs.mkdir(child, { recursive: true });

      const deps = makeDeps({
        gather: vi.fn(async () => ({ candidates: [], bySource: ZERO_SOURCE })),
      });
      await runInit(child, { brain: "/b", yes: true }, deps);

      // Registry prefix / mapping base is the invocation dir, NOT the climbed parent repo.
      expect(deps.registerBrain).toHaveBeenCalledWith(child, "/b");
      expect(deps.registerBrain).not.toHaveBeenCalledWith(parent, "/b");
      // Mining still targets the actual git repo (the climbed root).
      expect(deps.gather).toHaveBeenCalledWith(parent);
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
});

describe("findRepoRoot", () => {
  it("walks up to the nearest .git ancestor", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-cli-root-")),
    );
    try {
      execFileSync("git", ["init", "-q", root], { stdio: "pipe" });
      const nested = path.join(root, "a", "b", "c");
      await fs.mkdir(nested, { recursive: true });
      expect(findRepoRoot(nested)).toBe(root);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to startDir when no .git ancestor exists", async () => {
    const dir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-cli-nogit-")),
    );
    try {
      expect(findRepoRoot(dir)).toBe(dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
