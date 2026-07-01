import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initBrain } from "../src/scaffold";
import { SCHEMA_VERSION } from "../src/schema";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "commons-scaffold-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Recursively snapshot every file under `root` as a sorted relPath -> contents map. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(abs: string): Promise<void> {
    for (const entry of (await fs.readdir(abs, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) await walk(child);
      else out.set(path.relative(root, child), await fs.readFile(child, "utf8"));
    }
  }
  await walk(root);
  return out;
}

describe("initBrain", () => {
  it("creates the four kind folders, each with .gitkeep and INDEX.md", async () => {
    await initBrain(dir);
    for (const kindDir of ["memory", "decisions", "work-state", "people"]) {
      expect((await fs.stat(path.join(dir, kindDir))).isDirectory()).toBe(true);
      await expect(fs.stat(path.join(dir, kindDir, ".gitkeep"))).resolves.toBeDefined();
      await expect(fs.stat(path.join(dir, kindDir, "INDEX.md"))).resolves.toBeDefined();
    }
  });

  it("writes .commons metadata pinned to SCHEMA_VERSION", async () => {
    await initBrain(dir, { name: "acme-brain" });
    const version = await fs.readFile(path.join(dir, ".commons", "schema-version"), "utf8");
    expect(version.trim()).toBe(String(SCHEMA_VERSION));
    const config = JSON.parse(await fs.readFile(path.join(dir, ".commons", "config.json"), "utf8"));
    expect(config.name).toBe("acme-brain");
    expect(config.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("writes union-merge .gitattributes and index-ignoring .gitignore", async () => {
    await initBrain(dir);
    const attrs = await fs.readFile(path.join(dir, ".gitattributes"), "utf8");
    expect(attrs).toContain("COMMONS.md merge=union");
    expect(attrs).toContain("INDEX.md merge=union");
    const ignore = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
    expect(ignore).toContain("index/");
    expect(ignore).toContain("*.db");
    await expect(fs.stat(path.join(dir, "COMMONS.md"))).resolves.toBeDefined();
  });

  it("is byte-idempotent: a second run produces identical files", async () => {
    await initBrain(dir, { name: "x" });
    const first = await snapshot(dir);
    await initBrain(dir, { name: "x" }); // no throw, no drift
    const second = await snapshot(dir);
    expect([...second.entries()].sort()).toEqual([...first.entries()].sort());
  });

  it("refuses a directory with stray non-brain files unless forced", async () => {
    await fs.writeFile(path.join(dir, "README.md"), "hi");
    await expect(initBrain(dir)).rejects.toThrow();
    await expect(initBrain(dir, { force: true })).resolves.toBeUndefined();
    await expect(fs.stat(path.join(dir, "memory"))).resolves.toBeDefined();
  });
});
