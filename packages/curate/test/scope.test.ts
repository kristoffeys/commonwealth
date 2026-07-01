import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isInScope, loadUserConfig, saveUserConfig, type UserConfig } from "../src/scope.js";

let configDir: string;
let configPath: string;

beforeEach(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "commons-curate-scope-"));
  configPath = path.join(configDir, "config.json");
  // Point every scope-aware default at this temp file; never touch the real ~/.commons.
  process.env.COMMONS_CONFIG = configPath;
});

afterEach(async () => {
  delete process.env.COMMONS_CONFIG;
  await fs.rm(configDir, { recursive: true, force: true });
});

describe("isInScope", () => {
  it("puts everything in scope for an empty config", () => {
    const config: UserConfig = { allow: [], deny: [] };
    expect(isInScope("/anywhere/at/all", config)).toBe(true);
    expect(isInScope("/personal/secret", config)).toBe(true);
  });

  it("honors an allow list", () => {
    const config: UserConfig = { allow: ["/work"], deny: [] };
    expect(isInScope("/work/project", config)).toBe(true);
    expect(isInScope("/work", config)).toBe(true);
    expect(isInScope("/personal", config)).toBe(false);
    // A sibling that merely shares a prefix string is not "under" the allow root.
    expect(isInScope("/workshop", config)).toBe(false);
  });

  it("lets deny win over allow", () => {
    const config: UserConfig = { allow: ["/work"], deny: ["/work/secret"] };
    expect(isInScope("/work/proj", config)).toBe(true);
    expect(isInScope("/work/secret/x", config)).toBe(false);
    expect(isInScope("/work/secret", config)).toBe(false);
  });

  it("expands a tilde entry against the home directory", () => {
    const home = os.homedir();
    const config: UserConfig = { allow: ["~/foo"], deny: [] };
    expect(isInScope(path.join(home, "foo", "bar"), config)).toBe(true);
    expect(isInScope(path.join(home, "other"), config)).toBe(false);
  });

  it("treats the filesystem root as containing everything", () => {
    expect(isInScope("/anything/here", { allow: ["/"], deny: [] })).toBe(true);
    // deny of root blocks everything (allow is satisfied by root, then deny wins)
    expect(isInScope("/anything/here", { allow: ["/"], deny: ["/"] })).toBe(false);
  });
});

describe("config IO", () => {
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
