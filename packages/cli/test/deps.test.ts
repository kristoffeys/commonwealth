import { describe, expect, it, vi } from "vitest";
import { codexListJsonHasEntry, installCodexPlugin } from "../src/deps.js";

describe("codexListJsonHasEntry", () => {
  it("finds installed plugins and configured marketplaces", () => {
    expect(
      codexListJsonHasEntry(
        JSON.stringify({ installed: [{ pluginId: "commonwealth@commonwealth" }] }),
        "commonwealth",
      ),
    ).toBe(true);
    expect(
      codexListJsonHasEntry(
        JSON.stringify({ marketplaces: [{ name: "commonwealth" }] }),
        "commonwealth",
      ),
    ).toBe(true);
  });

  it("does not confuse an available plugin with an installed plugin", () => {
    expect(
      codexListJsonHasEntry(
        JSON.stringify({
          installed: [],
          available: [{ pluginId: "commonwealth@commonwealth", name: "commonwealth" }],
        }),
        "commonwealth",
      ),
    ).toBe(false);
  });
});

describe("installCodexPlugin", () => {
  const source = "/workspace/commonwealth";

  it("adds the marketplace and plugin on first install", () => {
    const run = vi.fn(() => ({ status: 0 }));
    const result = installCodexPlugin({
      hasExecutable: () => true,
      hasEntry: () => false,
      run,
      source,
    });

    expect(result).toEqual({ installed: true });
    expect(run.mock.calls).toEqual([
      [["plugin", "marketplace", "add", source]],
      [["plugin", "add", "commonwealth@commonwealth"]],
    ]);
  });

  it("is idempotent when the marketplace and plugin already exist", () => {
    const run = vi.fn(() => ({ status: 0 }));
    const result = installCodexPlugin({
      hasExecutable: () => true,
      hasEntry: () => true,
      run,
      source,
    });

    expect(result).toEqual({ installed: true });
    expect(run).not.toHaveBeenCalled();
  });

  it("reports a missing Codex CLI without running commands", () => {
    const run = vi.fn(() => ({ status: 0 }));
    const result = installCodexPlugin({
      hasExecutable: () => false,
      hasEntry: () => false,
      run,
      source,
    });

    expect(result).toEqual({ installed: false, skipped: "codex CLI not found" });
    expect(run).not.toHaveBeenCalled();
  });

  it("reports marketplace and plugin command failures precisely", () => {
    const marketplaceFailure = installCodexPlugin({
      hasExecutable: () => true,
      hasEntry: () => false,
      run: () => ({ status: 17 }),
      source,
    });
    expect(marketplaceFailure).toEqual({
      installed: false,
      skipped: "codex plugin marketplace add failed (code 17)",
    });

    const pluginFailure = installCodexPlugin({
      hasExecutable: () => true,
      hasEntry: (args) => args.includes("marketplace"),
      run: () => ({ status: null, error: new Error("spawn EACCES") }),
      source,
    });
    expect(pluginFailure).toEqual({
      installed: false,
      skipped: "codex plugin add failed (spawn EACCES)",
    });
  });
});
