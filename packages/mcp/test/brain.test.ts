import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initBrain } from "@commonwealth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveBrainDir } from "../src/brain.js";

/**
 * The MCP server must resolve its brain the same way the rest of Commonwealth does: an
 * explicit `COMMONWEALTH_BRAIN_DIR` wins, otherwise `@commonwealth/core`'s registry maps the
 * cwd to a brain, and when nothing maps we return `null` — the server surfaces an explicit
 * "no brain configured" error rather than silently adopting the cwd (#64).
 */

let tmp: string;
const savedEnv = {
  brain: process.env.COMMONWEALTH_BRAIN_DIR,
  registry: process.env.COMMONWEALTH_REGISTRY,
  config: process.env.COMMONWEALTH_CONFIG,
};
const savedCwd = process.cwd();

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-mcp-brain-")));
  delete process.env.COMMONWEALTH_BRAIN_DIR;
  // Point the registry at a file we control so the host machine's real registry never leaks.
  process.env.COMMONWEALTH_REGISTRY = path.join(tmp, "registry.json");
  delete process.env.COMMONWEALTH_CONFIG;
});

afterEach(async () => {
  process.chdir(savedCwd);
  if (savedEnv.brain === undefined) delete process.env.COMMONWEALTH_BRAIN_DIR;
  else process.env.COMMONWEALTH_BRAIN_DIR = savedEnv.brain;
  if (savedEnv.registry === undefined) delete process.env.COMMONWEALTH_REGISTRY;
  else process.env.COMMONWEALTH_REGISTRY = savedEnv.registry;
  if (savedEnv.config === undefined) delete process.env.COMMONWEALTH_CONFIG;
  else process.env.COMMONWEALTH_CONFIG = savedEnv.config;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("resolveBrainDir (mcp)", () => {
  it("an explicit COMMONWEALTH_BRAIN_DIR wins over everything else", async () => {
    process.env.COMMONWEALTH_BRAIN_DIR = "/explicit/brain";
    await expect(resolveBrainDir()).resolves.toBe("/explicit/brain");
  });

  it("a cwd under a registry mapping resolves to that brain", async () => {
    const brain = path.join(tmp, "acme-brain");
    const project = path.join(tmp, "work", "acme-app");
    await initBrain(brain, { name: "acme-brain" });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(
      process.env.COMMONWEALTH_REGISTRY as string,
      JSON.stringify({ mappings: [{ prefix: path.join(tmp, "work"), brain }] }),
      "utf8",
    );

    process.chdir(project);
    await expect(resolveBrainDir()).resolves.toBe(brain);
  });

  it("returns null when the registry maps nothing (no silent cwd fallback)", async () => {
    const loose = path.join(tmp, "elsewhere");
    await fs.mkdir(loose, { recursive: true });
    // Registry file is absent; no marker, no ancestor brain -> core returns null, and the
    // MCP resolver propagates that null instead of adopting `loose` as a brain (#64).
    process.chdir(loose);
    await expect(resolveBrainDir()).resolves.toBeNull();
  });
});
