import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _demoScript, runDemo, type DemoEnv } from "../src/demo.js";

/**
 * `commonwealth demo` (#137). The load-bearing assertion is that each scripted question actually
 * surfaces its intended note — i.e. the reveal is real recall, not a scripted `cat`. Also covers
 * cleanup / --keep and no-real-state (a private tmpdir, never the registry).
 */
describe("runDemo", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "cw-demo-test-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function env(over: Partial<DemoEnv> = {}): DemoEnv & { lines: string[] } {
    const lines: string[] = [];
    return {
      mkTemp: () => fs.mkdtemp(path.join(root, "brain-")),
      cleanup: (dir) => fs.rm(dir, { recursive: true, force: true }),
      out: (line) => lines.push(line),
      keep: false,
      lines,
      ...over,
    };
  }

  it("each scripted question surfaces its intended note (the reveal is real recall)", async () => {
    const result = await runDemo(env());
    expect(result.beats).toHaveLength(_demoScript.length);
    for (let i = 0; i < _demoScript.length; i++) {
      const beat = result.beats[i]!;
      expect(beat.question).toBe(_demoScript[i]!.question);
      expect(beat.topTitle, `beat "${beat.question}"`).toContain(_demoScript[i]!.expectTitle);
    }
  });

  it("narrates the questions and answers to output", async () => {
    const e = env();
    await runDemo(e);
    const text = e.lines.join("\n");
    for (const beat of _demoScript) expect(text).toContain(beat.question);
    expect(text).toContain("commonwealth init"); // the call to action
  });

  it("cleans up the throwaway brain by default", async () => {
    const result = await runDemo(env());
    expect(existsSync(result.brainDir)).toBe(false);
    expect(result.kept).toBe(false);
  });

  it("keeps the brain and reports the path under --keep", async () => {
    const e = env({ keep: true });
    const result = await runDemo(e);
    expect(existsSync(result.brainDir)).toBe(true);
    expect(result.kept).toBe(true);
    expect(e.lines.join("\n")).toContain(result.brainDir);
  });
});
