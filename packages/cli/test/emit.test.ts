import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runEmit, upsertSentinelBlock, type EmitEnv } from "../src/emit.js";

/**
 * `commonwealth emit` writer (#135). The brain slice is faked (its rendering is covered in core's
 * emit.test.ts); these assert the file layout, the AGENTS.md sentinel block, and gitignore policy.
 */
describe("runEmit", () => {
  let project: string;
  const BLOCK = "# Team brain (Commonwealth)\n\nrendered slice\n";

  beforeEach(async () => {
    project = await fs.mkdtemp(path.join(os.tmpdir(), "cw-emit-cli-"));
  });
  afterEach(async () => {
    await fs.rm(project, { recursive: true, force: true });
  });

  function env(over: Partial<EmitEnv> = {}): EmitEnv {
    return {
      cwd: project,
      resolveBrain: () => Promise.resolve("/brains/acme"),
      resolveSource: () => Promise.resolve("acme/app"),
      render: () => Promise.resolve(BLOCK),
      now: () => new Date("2026-07-05T12:00:00Z"),
      ...over,
    };
  }
  const read = (rel: string) => fs.readFile(path.join(project, rel), "utf8");

  it("writes the three targets with generated markers", async () => {
    const result = await runEmit({}, env());
    expect(result.written).toEqual([
      ".cursor/rules/commonwealth.mdc",
      ".github/instructions/commonwealth.instructions.md",
      "AGENTS.md",
    ]);

    const cursor = await read(".cursor/rules/commonwealth.mdc");
    expect(cursor).toContain("alwaysApply: true");
    expect(cursor).toContain("rendered slice");
    expect(cursor).toContain("do not edit");

    const copilot = await read(".github/instructions/commonwealth.instructions.md");
    expect(copilot).toContain("applyTo:");
    expect(copilot).toContain("rendered slice");

    const agents = await read("AGENTS.md");
    expect(agents).toContain("BEGIN COMMONWEALTH");
    expect(agents).toContain("END COMMONWEALTH");
    expect(agents).toContain("rendered slice");
  });

  it("gitignores the wholly-owned files by default, not AGENTS.md", async () => {
    const result = await runEmit({}, env());
    expect(result.gitignored).toBe(true);
    const gi = await read(".gitignore");
    expect(gi).toContain(".cursor/rules/commonwealth.mdc");
    expect(gi).toContain(".github/instructions/commonwealth.instructions.md");
    expect(gi).not.toContain("AGENTS.md");
  });

  it("does not gitignore under --commit", async () => {
    const result = await runEmit({ commit: true }, env());
    expect(result.gitignored).toBe(false);
    await expect(read(".gitignore")).rejects.toThrow();
  });

  it("preserves user content in AGENTS.md outside the sentinel block", async () => {
    await fs.writeFile(path.join(project, "AGENTS.md"), "# My rules\n\nkeep me\n");
    await runEmit({}, env());
    const agents = await read("AGENTS.md");
    expect(agents).toContain("keep me");
    expect(agents).toContain("rendered slice");
  });

  it("replaces the block on re-emit instead of stacking duplicates", async () => {
    await runEmit({}, env({ render: () => Promise.resolve("first\n") }));
    await runEmit({}, env({ render: () => Promise.resolve("second\n") }));
    const agents = await read("AGENTS.md");
    expect(agents).toContain("second");
    expect(agents).not.toContain("first");
    expect(agents.match(/BEGIN COMMONWEALTH/g)?.length).toBe(1);
  });

  it("throws when no brain resolves", async () => {
    await expect(runEmit({}, env({ resolveBrain: () => Promise.resolve(null) }))).rejects.toThrow(
      /No Commonwealth brain/,
    );
  });
});

describe("upsertSentinelBlock", () => {
  it("appends a fenced block to content with no existing block", () => {
    const out = upsertSentinelBlock("# Existing\n", "hello");
    expect(out).toContain("# Existing");
    expect(out).toContain("BEGIN COMMONWEALTH");
    expect(out).toContain("hello");
  });

  it("is idempotent on the same block", () => {
    const once = upsertSentinelBlock("", "same");
    const twice = upsertSentinelBlock(once, "same");
    expect(twice).toBe(once);
  });
});
