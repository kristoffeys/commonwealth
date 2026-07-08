import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBrain, setFeature } from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureCandidates } from "../src/capture.js";
import { listStaged } from "../src/staging.js";
import type { NewNoteInput } from "@cmnwlth/core";

// The capture scope gate is now the single ADR-0024 §3 pass: `resolveBrain(cwd)` folds in the
// legacy allow/deny and answers `brain` (in scope) / `denied` (out of scope) / `none`. `isInScope`
// is retired; this suite exercises the gate through `resolveBrain` exactly as the CLI now does.

let brainDir: string;
let workDir: string;
let configDir: string;
let configPath: string;

const candidates: NewNoteInput[] = [
  {
    kind: "memory",
    title: "Cache TTL is five minutes",
    body: "The edge cache holds responses for five minutes before revalidating upstream.",
  },
];

/** Mirror of the CLI `capture` gate: skip unless the cwd resolves to a brain, else stage. */
async function captureIfInScope(cwd: string): Promise<number> {
  const resolution = await resolveBrain(cwd, { registryPath: configPath });
  if (resolution.kind !== "brain") return 0;
  const result = await captureCandidates(brainDir, candidates);
  return result.staged.length;
}

/** Write the per-user config (rules / allow / deny) the resolver reads. */
async function writeConfig(config: Record<string, unknown>): Promise<void> {
  await fs.writeFile(configPath, JSON.stringify(config), "utf8");
}

beforeEach(async () => {
  brainDir = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-curate-capscope-brain-"));
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-curate-capscope-work-"));
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
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.rm(configDir, { recursive: true, force: true });
});

describe("capture scope gate (via resolveBrain — ADR-0024 §3)", () => {
  it("stages nothing when the cwd is denied (legacy deny sugar → a deny rule)", async () => {
    await writeConfig({ deny: [workDir], rules: [{ prefix: workDir, brain: brainDir }] });
    const staged = await captureIfInScope(workDir);
    expect(staged).toBe(0);
    expect(await listStaged(brainDir)).toHaveLength(0);
  });

  it("stages nothing when nothing is configured for the cwd (none)", async () => {
    await writeConfig({});
    const staged = await captureIfInScope(workDir);
    expect(staged).toBe(0);
    expect(await listStaged(brainDir)).toHaveLength(0);
  });

  it("stages candidates when a rule routes the cwd to a brain (in scope)", async () => {
    await writeConfig({ rules: [{ prefix: workDir, brain: brainDir }] });
    const staged = await captureIfInScope(workDir);
    expect(staged).toBe(1);
    expect(await listStaged(brainDir)).toHaveLength(1);
  });

  it("a legacy allow entry is in scope when a default brain gives it a destination", async () => {
    await writeConfig({ allow: [workDir], defaultBrain: { brain: brainDir } });
    const staged = await captureIfInScope(workDir);
    expect(staged).toBe(1);
    expect(await listStaged(brainDir)).toHaveLength(1);
  });
});
