import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  brainConfigPath,
  defaultBrainConfig,
  isFeatureEnabled,
  loadBrainConfig,
  setFeature,
} from "../src/config";
import { initBrain } from "../src/scaffold";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "commons-config-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("defaultBrainConfig", () => {
  it("defaults autoAdr off", () => {
    expect(defaultBrainConfig("x").features.autoAdr).toBe(false);
  });
});

describe("brain config on a scaffolded brain", () => {
  it("scaffolds config.json with features.autoAdr === false", async () => {
    await initBrain(dir, { name: "acme-brain" });
    const config = JSON.parse(await fs.readFile(brainConfigPath(dir), "utf8"));
    expect(config.features.autoAdr).toBe(false);
  });

  it("isFeatureEnabled is false by default", async () => {
    await initBrain(dir);
    expect(await isFeatureEnabled(dir, "autoAdr")).toBe(false);
  });

  it("setFeature persists and reloads", async () => {
    await initBrain(dir);
    await setFeature(dir, "autoAdr", true);
    expect(await isFeatureEnabled(dir, "autoAdr")).toBe(true);
    // Re-load from disk to confirm persistence.
    const reloaded = await loadBrainConfig(dir);
    expect(reloaded.features.autoAdr).toBe(true);
  });
});

describe("loadBrainConfig resilience", () => {
  it("returns defaults without throwing when no config file exists", async () => {
    const config = await loadBrainConfig(dir); // fresh mkdtemp, no .commons
    expect(config.features.autoAdr).toBe(false);
    expect(config.remotes).toEqual([]);
    expect(config.curation).toEqual({});
    expect(config.name).toBe(path.basename(dir));
  });

  it("fills a missing feature key when the file omits it", async () => {
    await fs.mkdir(path.join(dir, ".commons"), { recursive: true });
    await fs.writeFile(
      brainConfigPath(dir),
      `${JSON.stringify({ name: "partial", schemaVersion: 1, remotes: [], curation: {}, features: {} }, null, 2)}\n`,
      "utf8",
    );
    const config = await loadBrainConfig(dir);
    expect(config.features.autoAdr).toBe(false);
  });

  it("preserves unknown feature keys and lets file values win", async () => {
    await fs.mkdir(path.join(dir, ".commons"), { recursive: true });
    await fs.writeFile(
      brainConfigPath(dir),
      `${JSON.stringify({ features: { autoAdr: true, futureFlag: true } }, null, 2)}\n`,
      "utf8",
    );
    const config = await loadBrainConfig(dir);
    expect(config.features.autoAdr).toBe(true);
    expect(config.features.futureFlag).toBe(true);
  });
});
