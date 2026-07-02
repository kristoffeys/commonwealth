import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  brainConfigPath,
  defaultBrainConfig,
  isFeatureEnabled,
  loadBrainConfig,
  saveBrainConfig,
  setFeature,
} from "../src/config";
import { SCHEMA_VERSION } from "../src/schema";
import { initBrain } from "../src/scaffold";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-config-"));
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
    const config = await loadBrainConfig(dir); // fresh mkdtemp, no .commonwealth
    expect(config.features.autoAdr).toBe(false);
    expect(config.remotes).toEqual([]);
    expect(config.curation).toEqual({});
    expect(config.name).toBe(path.basename(dir));
  });

  it("fills a missing feature key when the file omits it", async () => {
    await fs.mkdir(path.join(dir, ".commonwealth"), { recursive: true });
    await fs.writeFile(
      brainConfigPath(dir),
      `${JSON.stringify({ name: "partial", schemaVersion: 1, remotes: [], curation: {}, features: {} }, null, 2)}\n`,
      "utf8",
    );
    const config = await loadBrainConfig(dir);
    expect(config.features.autoAdr).toBe(false);
  });

  it("preserves unknown feature keys and lets file values win", async () => {
    await fs.mkdir(path.join(dir, ".commonwealth"), { recursive: true });
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

describe("saveBrainConfig durability (#101)", () => {
  it("writes atomically and leaves no temp file behind", async () => {
    const cfg = defaultBrainConfig("acme");
    cfg.remotes = ["git@github.com:acme/brain.git"];
    await saveBrainConfig(dir, cfg);

    // Round-trips…
    const back = await loadBrainConfig(dir);
    expect(back.remotes).toEqual(["git@github.com:acme/brain.git"]);
    // …and no `.tmp` sidecar is left in .commonwealth/ (rename cleaned it up).
    const entries = await fs.readdir(path.join(dir, ".commonwealth"));
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });

  it("warns once when the on-disk config is a newer schema than this build", async () => {
    await fs.mkdir(path.join(dir, ".commonwealth"), { recursive: true });
    await fs.writeFile(
      brainConfigPath(dir),
      `${JSON.stringify({ name: "future", schemaVersion: SCHEMA_VERSION + 5, features: {} })}\n`,
      "utf8",
    );
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    let skewWarnings: string[];
    try {
      await loadBrainConfig(dir);
      await loadBrainConfig(dir); // second read must NOT warn again (once per brain)
      // Capture BEFORE mockRestore(), which clears mock.calls.
      skewWarnings = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("schema v"));
    } finally {
      warn.mockRestore();
    }
    expect(skewWarnings).toHaveLength(1);
  });
});
