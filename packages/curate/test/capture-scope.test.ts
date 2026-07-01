import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setFeature } from "@commonwealth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureCandidates } from "../src/capture.js";
import { isInScope, loadUserConfig, saveUserConfig } from "../src/scope.js";
import { listStaged } from "../src/staging.js";
import type { NewNoteInput } from "@commonwealth/core";

let brainDir: string;
let configDir: string;
let configPath: string;

const candidates: NewNoteInput[] = [
  {
    kind: "memory",
    title: "Cache TTL is five minutes",
    body: "The edge cache holds responses for five minutes before revalidating upstream.",
  },
];

/** Mirror of the CLI `capture` gate: skip out-of-scope cwds, else stage candidates. */
async function captureIfInScope(cwd: string): Promise<number> {
  const config = await loadUserConfig(configPath);
  if (!isInScope(cwd, config)) return 0;
  const result = await captureCandidates(brainDir, candidates);
  return result.staged.length;
}

beforeEach(async () => {
  brainDir = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-curate-capscope-brain-"));
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-curate-capscope-cfg-"));
  configPath = path.join(configDir, "config.json");
  process.env.COMMONWEALTH_CONFIG = configPath;
  // This suite isolates the per-user scope gate; turn autoPromote off so a captured note stays
  // observable in `staging/` rather than being promoted straight to canon (ADR-0014).
  await setFeature(brainDir, "autoPromote", false);
});

afterEach(async () => {
  delete process.env.COMMONWEALTH_CONFIG;
  await fs.rm(brainDir, { recursive: true, force: true });
  await fs.rm(configDir, { recursive: true, force: true });
});

describe("capture scope gate", () => {
  it("stages nothing when the cwd is deny-listed", async () => {
    await saveUserConfig({ allow: [], deny: [brainDir] }, configPath);
    const staged = await captureIfInScope(brainDir);
    expect(staged).toBe(0);
    expect(await listStaged(brainDir)).toHaveLength(0);
  });

  it("stages candidates when the cwd is in scope", async () => {
    await saveUserConfig({ allow: [brainDir], deny: [] }, configPath);
    const staged = await captureIfInScope(brainDir);
    expect(staged).toBe(1);
    expect(await listStaged(brainDir)).toHaveLength(1);
  });
});
