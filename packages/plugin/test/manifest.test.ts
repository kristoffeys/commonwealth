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
  it("is valid JSON naming the plugin 'commonwealth' with mcpServers as a file ref", () => {
    const manifest = readJson(".claude-plugin/plugin.json") as Record<string, unknown>;
    expect(manifest.name).toBe("commonwealth");
    expect(typeof manifest.version).toBe("string");

    // Claude Code loads mcpServers as a STRING path to a file at the plugin root (an inline
    // mcpServers object is NOT picked up — it silently registers zero MCP servers).
    expect(typeof manifest.mcpServers).toBe("string");
    const mcpRel = manifest.mcpServers as string;
    expect(existsSync(path.join(pluginRoot, mcpRel))).toBe(true);

    // The manifest MUST NOT declare `hooks`: Claude Code auto-loads the standard
    // `hooks/hooks.json`, so naming it here double-registers it and fails hook loading with
    // "Duplicate hooks file detected". `manifest.hooks` may only name ADDITIONAL, non-standard
    // hook files — which we don't have.
    expect(manifest.hooks).toBeUndefined();
    expect(existsSync(path.join(pluginRoot, "hooks/hooks.json"))).toBe(true);
  });

  it("the referenced .mcp.json runs the published MCP server via npx (#62)", () => {
    const manifest = readJson(".claude-plugin/plugin.json") as { mcpServers: string };
    const mcp = readJson(manifest.mcpServers) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    const server = mcp.mcpServers["commonwealth"];
    expect(server).toBeDefined();
    // npx fetches the published package on demand — no committed vendor/ to break GitHub installs.
    expect(server.command).toBe("npx");
    expect(server.args.join(" ")).toContain("@cmnwlth/mcp");
  });
});

describe(".codex-plugin/plugin.json", () => {
  it("declares a Codex plugin backed by the shared MCP config", () => {
    const manifest = readJson(".codex-plugin/plugin.json") as Record<string, unknown>;
    expect(manifest.name).toBe("commonwealth");
    expect(manifest.version).toBe(
      (readJson(".claude-plugin/plugin.json") as { version: string }).version,
    );
    expect(manifest.mcpServers).toBe("./.mcp.json");
    expect(existsSync(path.join(pluginRoot, manifest.mcpServers as string))).toBe(true);

    // Codex lifecycle capture is tracked separately (#225); this first slice must not advertise
    // Claude's SessionEnd semantics as if they already worked in Codex.
    expect(manifest.hooks).toBeUndefined();
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

    // The legacy-compatible marketplace serves both hosts; each host requires its own manifest.
    const source = path.resolve(repoRoot, entry?.source as string);
    expect(existsSync(source)).toBe(true);
    expect(existsSync(path.join(source, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(path.join(source, ".codex-plugin", "plugin.json"))).toBe(true);
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

describe("agents/curator.md (subagent — #198)", () => {
  it("ships a curator subagent with name + description + scoped tools", () => {
    const file = path.join(pluginRoot, "agents", "curator.md");
    expect(existsSync(file)).toBe(true);
    const raw = readFileSync(file, "utf8");

    // A Claude Code subagent is YAML frontmatter (name/description/tools) + a markdown body prompt.
    expect(raw.startsWith("---\n")).toBe(true);
    const end = raw.indexOf("\n---", 3);
    expect(end).toBeGreaterThan(0);
    const front = raw.slice(4, end);
    const body = raw.slice(end + 4).trim();

    // Named `curator` so it is invokable as @commonwealth:curator.
    expect(/^name:\s*curator\s*$/m.test(front)).toBe(true);
    expect(/^description:/m.test(front)).toBe(true);

    // Scoped to the Commonwealth MCP tools + Bash (for the review CLI). It must NOT be granted
    // broad write tools like Write/Edit — the curator is advisory (read + review-CLI only).
    expect(/^tools:.*mcp__commonwealth__search/m.test(front)).toBe(true);
    expect(/^tools:.*\bBash\b/m.test(front)).toBe(true);
    expect(/^tools:.*\b(Write|Edit)\b/m.test(front)).toBe(false);

    // The prompt must encode the advisory posture (never auto-promote).
    expect(body.length).toBeGreaterThan(0);
    expect(/never|advisory|recommend/i.test(body)).toBe(true);
  });
});

describe("hooks/hooks.json", () => {
  it("references the SessionStart, SessionEnd, PreCompact, and UserPromptSubmit hook scripts", () => {
    const hooks = readJson("hooks/hooks.json") as {
      hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
    };
    const start = hooks.hooks.SessionStart?.[0]?.hooks?.[0];
    const end = hooks.hooks.SessionEnd?.[0]?.hooks?.[0];
    const preCompact = hooks.hooks.PreCompact?.[0]?.hooks?.[0];
    const prompt = hooks.hooks.UserPromptSubmit?.[0]?.hooks?.[0];

    expect(start?.type).toBe("command");
    expect(start?.command).toContain("hooks/session-start.mjs");
    expect(start?.command).toContain("${CLAUDE_PLUGIN_ROOT}");

    expect(end?.type).toBe("command");
    expect(end?.command).toContain("hooks/session-end.mjs");
    expect(end?.command).toContain("${CLAUDE_PLUGIN_ROOT}");

    // PreCompact captures long-session knowledge before compaction (#195), reusing the worker.
    expect(preCompact?.type).toBe("command");
    expect(preCompact?.command).toContain("hooks/pre-compact.mjs");
    expect(preCompact?.command).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(existsSync(path.join(pluginRoot, "hooks", "pre-compact.mjs"))).toBe(true);

    // Per-prompt context injection + throttled capture (#194).
    expect(prompt?.type).toBe("command");
    expect(prompt?.command).toContain("hooks/user-prompt-submit.mjs");
    expect(prompt?.command).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(existsSync(path.join(pluginRoot, "hooks", "user-prompt-submit.mjs"))).toBe(true);
  });
});
