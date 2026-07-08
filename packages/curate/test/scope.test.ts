import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAllow, loadUserConfig, saveUserConfig, type UserConfig } from "../src/scope.js";

let configDir: string;
let configPath: string;

beforeEach(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-curate-scope-"));
  configPath = path.join(configDir, "config.json");
  // Point every scope-aware default at this temp file; never touch the real ~/.commonwealth.
  process.env.COMMONWEALTH_CONFIG = configPath;
});

afterEach(async () => {
  delete process.env.COMMONWEALTH_CONFIG;
  await fs.rm(configDir, { recursive: true, force: true });
});

// NOTE: `isInScope` is retired (ADR-0024 §3). The scope decision now lives in `@cmnwlth/core`'s
// `resolveBrain`, which folds these `allow`/`deny` lists into its ruleset and returns
// `brain`/`denied`/`none`. That folding is covered in core's rule-resolution.test.ts; here we only
// keep the config IO (still the readable sugar the `scope` CLI edits).

describe("addAllow", () => {
  it("returns the resolved absolute path it persisted (tilde expanded), idempotently", async () => {
    const returned = await addAllow("~/allowed-folder", configPath);
    expect(returned).toBe(path.join(os.homedir(), "allowed-folder"));
    expect((await loadUserConfig(configPath)).allow).toEqual([returned]);

    // Adding the same path again is a no-op but still returns the resolved entry.
    expect(await addAllow("~/allowed-folder", configPath)).toBe(returned);
    expect((await loadUserConfig(configPath)).allow).toEqual([returned]);
  });
});

describe("config IO — preserving co-tenant keys (ADR-0024 §6)", () => {
  it("addAllow preserves brain-resolution `rules`/`defaultBrain` in the shared config.json", async () => {
    // core writes rules into the SAME file; a scope write must not clobber them.
    await fs.writeFile(
      configPath,
      JSON.stringify({ rules: [{ org: "weareantenna/*" }], defaultBrain: { brain: "/b" } }),
      "utf8",
    );
    await addAllow("~/work", configPath);
    const written = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(written.rules).toEqual([{ org: "weareantenna/*" }]);
    expect(written.defaultBrain).toEqual({ brain: "/b" });
    expect(written.allow).toEqual([path.join(os.homedir(), "work")]);
  });

  it("refuses to clobber a corrupt config, backing it up", async () => {
    await fs.writeFile(configPath, "{ not json ]", "utf8");
    await expect(addAllow("~/work", configPath)).rejects.toThrow(/corrupt/i);
    const dir = path.dirname(configPath);
    const files = await fs.readdir(dir);
    expect(files.some((f) => f.startsWith(`${path.basename(configPath)}.corrupt-`))).toBe(true);
  });

  it("returns empty arrays for a missing file without throwing", async () => {
    const config = await loadUserConfig(configPath);
    expect(config).toEqual({ allow: [], deny: [] });
  });

  it("round-trips through save then load", async () => {
    const original: UserConfig = { allow: ["/work", "~/code"], deny: ["/work/secret"] };
    await saveUserConfig(original, configPath);
    const loaded = await loadUserConfig(configPath);
    expect(loaded).toEqual(original);

    // Pretty JSON with a trailing newline.
    const raw = await fs.readFile(configPath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain("\n  ");
  });
});
