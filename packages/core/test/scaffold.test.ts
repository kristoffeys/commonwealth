import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBrainConfig, setFeature } from "../src/config";
import { initBrain } from "../src/scaffold";
import { SCHEMA_VERSION } from "../src/schema";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-scaffold-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/**
 * Recursively snapshot every file under `root` as a sorted relPath -> contents map. Skips
 * `.git`: the generated repo carries non-deterministic bytes (commit timestamps, object
 * packs) that are irrelevant to scaffold-file idempotency.
 */
async function snapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(abs: string): Promise<void> {
    for (const entry of (await fs.readdir(abs, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      if (entry.name === ".git") continue;
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

  it("writes .commonwealth metadata pinned to SCHEMA_VERSION", async () => {
    await initBrain(dir, { name: "acme-brain" });
    const version = await fs.readFile(path.join(dir, ".commonwealth", "schema-version"), "utf8");
    expect(version.trim()).toBe(String(SCHEMA_VERSION));
    const config = JSON.parse(
      await fs.readFile(path.join(dir, ".commonwealth", "config.json"), "utf8"),
    );
    expect(config.name).toBe("acme-brain");
    expect(config.schemaVersion).toBe(SCHEMA_VERSION);
    expect(config.features.autoAdr).toBe(true); // decisions traced by default (ADR-0022)
  });

  it("writes union-merge .gitattributes and index-ignoring .gitignore", async () => {
    await initBrain(dir);
    const attrs = await fs.readFile(path.join(dir, ".gitattributes"), "utf8");
    expect(attrs).toContain("COMMONWEALTH.md merge=union");
    expect(attrs).toContain("INDEX.md merge=union");
    const ignore = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
    expect(ignore).toContain("index/");
    expect(ignore).toContain("staging/"); // per-user review queue, never synced (ADR-0008)
    expect(ignore).toContain("*.db");
    await expect(fs.stat(path.join(dir, "COMMONWEALTH.md"))).resolves.toBeDefined();
  });

  it("writes a commented-out CODEOWNERS sample for `promote --pr` (#215)", async () => {
    await initBrain(dir);
    const codeowners = await fs.readFile(path.join(dir, ".github", "CODEOWNERS"), "utf8");
    // The sample is fully commented so an active-but-ownerless rule never blocks every PR.
    for (const line of codeowners.split("\n")) {
      expect(line === "" || line.startsWith("#")).toBe(true);
    }
    expect(codeowners).toContain("decisions/");
  });

  it("is byte-idempotent: a second run produces identical files", async () => {
    await initBrain(dir, { name: "x" });
    const first = await snapshot(dir);
    await initBrain(dir, { name: "x" }); // no throw, no drift
    const second = await snapshot(dir);
    expect([...second.entries()].sort()).toEqual([...first.entries()].sort());
  });

  it("makes the brain a git repo with a single initial commit (issue #66)", async () => {
    await initBrain(dir, { name: "acme-brain" });
    // It is a repo whose root is the brain itself — not an ancestor it walked up to.
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir })
      .toString()
      .trim();
    expect(await fs.realpath(top)).toBe(await fs.realpath(dir));
    // Exactly one commit, and the scaffold is fully committed (clean working tree).
    const count = execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: dir })
      .toString()
      .trim();
    expect(count).toBe("1");
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: dir }).toString().trim();
    expect(status).toBe("");
    expect(execFileSync("git", ["ls-files"], { cwd: dir }).toString()).toContain("COMMONWEALTH.md");
  });

  it("leaves an existing .git untouched (a clone keeps its history)", async () => {
    // Simulate a caller that set up its own repo before scaffolding (the sync fixtures do).
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    execFileSync(
      "git",
      [
        "-c",
        "user.name=x",
        "-c",
        "user.email=x@y",
        "commit",
        "--allow-empty",
        "-qm",
        "pre-existing",
      ],
      { cwd: dir },
    );
    await initBrain(dir, { name: "acme-brain" });
    // initBrain did not add a second commit of its own on top of the caller's history.
    const count = execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: dir })
      .toString()
      .trim();
    expect(count).toBe("1");
  });

  it("refuses a directory with stray non-brain files unless forced", async () => {
    await fs.writeFile(path.join(dir, "README.md"), "hi");
    await expect(initBrain(dir)).rejects.toThrow();
    await expect(initBrain(dir, { force: true })).resolves.toBeUndefined();
    await expect(fs.stat(path.join(dir, "memory"))).resolves.toBeDefined();
  });

  it("re-inits an existing brain even with runtime entries present (reseed) without force", async () => {
    await initBrain(dir, { name: "x" });
    // Simulate a lived-in brain: review queue, macOS cruft, and a per-project note folder
    // (ADR-0015) — none of which are in BRAIN_ENTRIES.
    await fs.mkdir(path.join(dir, "staging", "memory"), { recursive: true });
    await fs.mkdir(path.join(dir, "acme-widgets", "memory"), { recursive: true });
    await fs.writeFile(path.join(dir, ".DS_Store"), "\0\0");
    // Reseed re-runs initBrain on the existing brain; it must NOT throw (was the crash).
    await expect(initBrain(dir, { name: "x" })).resolves.toBeUndefined();
    // Runtime entries survive the re-init.
    await expect(fs.stat(path.join(dir, "acme-widgets", "memory"))).resolves.toBeDefined();
  });

  it("re-init preserves a team-modified config.json instead of resetting it (#75)", async () => {
    await initBrain(dir, { name: "acme" });
    // Team customizes the brain: turn off autoPromote and add a remote.
    await setFeature(dir, "autoPromote", false);
    const configPath = path.join(dir, ".commonwealth", "config.json");
    const customized = JSON.parse(await fs.readFile(configPath, "utf8"));
    customized.remotes = ["git@github.com:acme/brain.git"];
    await fs.writeFile(configPath, `${JSON.stringify(customized, null, 2)}\n`, "utf8");

    // A reseed re-runs initBrain on the existing brain — it must NOT clobber the config.
    await initBrain(dir, { name: "acme" });

    const after = await loadBrainConfig(dir);
    expect(after.features.autoPromote).toBe(false);
    expect(after.remotes).toEqual(["git@github.com:acme/brain.git"]);
  });
});
