import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
