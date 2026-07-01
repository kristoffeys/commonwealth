import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(pluginRoot, "..", "..");

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(path.join(pluginRoot, rel), "utf8"));
}

describe(".claude-plugin/plugin.json", () => {
  it("is valid JSON naming the plugin 'commonwealth' with mcpServers + hooks", () => {
    const manifest = readJson(".claude-plugin/plugin.json") as Record<string, unknown>;
    expect(manifest.name).toBe("commonwealth");
    expect(typeof manifest.version).toBe("string");

    const mcp = manifest.mcpServers as Record<string, { command: string; args: string[] }>;
    expect(mcp["commonwealth-brain"]).toBeDefined();
    expect(mcp["commonwealth-brain"].command).toBe("node");
    expect(mcp["commonwealth-brain"].args.join(" ")).toContain("vendor/mcp/index.js");
    expect(mcp["commonwealth-brain"].args.join(" ")).toContain("${CLAUDE_PLUGIN_ROOT}");

    expect(typeof manifest.hooks).toBe("string");
    expect(manifest.hooks as string).toContain("hooks/hooks.json");
  });
});

describe("repo-root .claude-plugin/marketplace.json", () => {
  it("is valid JSON declaring the commonwealth plugin whose source path exists", () => {
    const raw = readFileSync(path.join(repoRoot, ".claude-plugin", "marketplace.json"), "utf8");
    const market = JSON.parse(raw) as {
      name: string;
      owner: unknown;
      plugins: Array<{ name: string; source: string; description?: string }>;
    };

    expect(market.name).toBe("commonwealth");
    expect(market.owner).toBeTruthy();

    const entry = market.plugins.find((p) => p.name === "commonwealth");
    expect(entry).toBeDefined();
    expect(entry?.source).toBe("./packages/plugin");
    expect(typeof entry?.description).toBe("string");

    // The declared source path must resolve to a real plugin (its plugin.json exists).
    const source = path.resolve(repoRoot, entry?.source as string);
    expect(existsSync(source)).toBe(true);
    expect(existsSync(path.join(source, ".claude-plugin", "plugin.json"))).toBe(true);
  });

  it("keeps the marketplace entry version in agreement with the plugin.json version", () => {
    const raw = readFileSync(path.join(repoRoot, ".claude-plugin", "marketplace.json"), "utf8");
    const market = JSON.parse(raw) as {
      plugins: Array<{ name: string; version?: string }>;
    };
    const entry = market.plugins.find((p) => p.name === "commonwealth");
    const plugin = readJson(".claude-plugin/plugin.json") as { version: string };
    // Only assert agreement when the marketplace pins a version (it may omit it).
    if (entry?.version !== undefined) {
      expect(entry.version).toBe(plugin.version);
    }
  });
});

describe("hooks/hooks.json", () => {
  it("references both the SessionStart and SessionEnd hook scripts", () => {
    const hooks = readJson("hooks/hooks.json") as {
      hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
    };
    const start = hooks.hooks.SessionStart?.[0]?.hooks?.[0];
    const end = hooks.hooks.SessionEnd?.[0]?.hooks?.[0];

    expect(start?.type).toBe("command");
    expect(start?.command).toContain("hooks/session-start.mjs");
    expect(start?.command).toContain("${CLAUDE_PLUGIN_ROOT}");

    expect(end?.type).toBe("command");
    expect(end?.command).toContain("hooks/session-end.mjs");
    expect(end?.command).toContain("${CLAUDE_PLUGIN_ROOT}");
  });
});
