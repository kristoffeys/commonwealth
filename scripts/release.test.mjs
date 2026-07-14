import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  applyVersion,
  currentVersion,
  nextVersion,
  PLUGIN_RUNTIME_FILES,
  verifyRelease,
} from "./release.mjs";

describe("nextVersion", () => {
  it("bumps patch/minor/major, zeroing lower components", () => {
    expect(nextVersion("0.1.2", "patch")).toBe("0.1.3");
    expect(nextVersion("0.1.2", "minor")).toBe("0.2.0");
    expect(nextVersion("0.1.2", "major")).toBe("1.0.0");
    expect(nextVersion("1.9.9", "minor")).toBe("1.10.0");
  });

  it("accepts an explicit forward version", () => {
    expect(nextVersion("0.1.2", "0.1.5")).toBe("0.1.5");
    expect(nextVersion("0.1.2", "1.0.0")).toBe("1.0.0");
  });

  it("rejects a non-forward explicit version (guards typos/downgrades)", () => {
    expect(() => nextVersion("0.1.2", "0.1.2")).toThrow(/not greater than/);
    expect(() => nextVersion("0.1.2", "0.1.1")).toThrow(/not greater than/);
    expect(() => nextVersion("2.0.0", "1.9.9")).toThrow(/not greater than/);
  });

  it("rejects a malformed version argument", () => {
    expect(() => nextVersion("0.1.2", "v1")).toThrow(/not a semver/);
    expect(() => nextVersion("0.1.2", "1.2")).toThrow(/not a semver/);
  });
});

describe("applyVersion", () => {
  it("keeps the Codex plugin manifest in the release version set", () => {
    const target = nextVersion(currentVersion(), "patch");
    const changed = applyVersion(target, { dryRun: true });

    expect(
      changed.some((file) =>
        file.endsWith(path.join("packages", "plugin", ".codex-plugin", "plugin.json")),
      ),
    ).toBe(true);
  });
});

describe("verifyRelease", () => {
  it("proves version pins and the portable Claude/Codex payload agree", () => {
    const result = verifyRelease();

    expect(result.version).toBe(currentVersion());
    expect(result.runtimeFiles).toEqual(PLUGIN_RUNTIME_FILES);
    expect(result.runtimeFiles).toEqual(
      expect.arrayContaining([
        ".claude-plugin/plugin.json",
        ".codex-plugin/plugin.json",
        ".mcp.json",
        "hooks/hooks.json",
        "hooks/codex-hooks.json",
        "hooks/codex-hook.mjs",
        "hooks/capture-worker.mjs",
        "hooks/extraction.mjs",
        "hooks/extraction-schema.json",
      ]),
    );
  });
});
