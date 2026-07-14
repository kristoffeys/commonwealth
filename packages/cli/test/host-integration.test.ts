import path from "node:path";
import { EMIT_BEGIN, EMIT_END } from "@cmnwlth/core";
import { describe, expect, it, vi } from "vitest";
import {
  diagnoseHostIntegrations,
  parseClaudePluginList,
  parseCodexPluginList,
  type HostIntegrationEnv,
  type SafeCommandResult,
} from "../src/host-integration.js";

const CLAUDE_ROOT = "/plugins/commonwealth-claude";
const CODEX_HOME = "/codex";
const CODEX_ROOT = path.join(
  CODEX_HOME,
  "plugins",
  "cache",
  "commonwealth",
  "commonwealth",
  "0.1.12",
);

function command(status = 0, stdout = ""): SafeCommandResult {
  return { status, stdout, error: false };
}

function manifests(): Map<string, string> {
  const hook = { hooks: [{ type: "command", command: "node hook.mjs" }] };
  return new Map([
    [
      path.join(CLAUDE_ROOT, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "commonwealth", mcpServers: "./.mcp.json" }),
    ],
    [
      path.join(CODEX_ROOT, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "commonwealth",
        mcpServers: "./.mcp.json",
        hooks: "./hooks/codex-hooks.json",
      }),
    ],
    [
      path.join(CLAUDE_ROOT, ".mcp.json"),
      JSON.stringify({
        mcpServers: { commonwealth: { command: "npx", env: { TOKEN: "secret" } } },
      }),
    ],
    [
      path.join(CODEX_ROOT, ".mcp.json"),
      JSON.stringify({
        mcpServers: { commonwealth: { command: "npx", env: { TOKEN: "secret" } } },
      }),
    ],
    [
      path.join(CLAUDE_ROOT, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [hook],
          UserPromptSubmit: [hook],
          PreCompact: [hook],
          SessionEnd: [hook],
        },
      }),
    ],
    [
      path.join(CODEX_ROOT, "hooks", "codex-hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [hook],
          UserPromptSubmit: [hook],
          PreCompact: [hook],
          Stop: [hook],
        },
      }),
    ],
    [path.join(CLAUDE_ROOT, "hooks", "extraction.mjs"), "export function createExtractor() {}"],
    [path.join(CODEX_ROOT, "hooks", "extraction.mjs"), "export function createExtractor() {}"],
    [path.join(CLAUDE_ROOT, "hooks", "extraction-schema.json"), JSON.stringify({ type: "object" })],
    [path.join(CODEX_ROOT, "hooks", "extraction-schema.json"), JSON.stringify({ type: "object" })],
    [path.join("/work/project", "AGENTS.md"), `${EMIT_BEGIN}\nteam context\n${EMIT_END}\n`],
  ]);
}

function healthyEnv(
  overrides: Partial<HostIntegrationEnv> = {},
  files = manifests(),
): HostIntegrationEnv {
  return {
    cwd: "/work/project",
    codexHome: CODEX_HOME,
    run: vi.fn((host: string, args: string[]) => {
      if (args.join(" ") === "plugin list --json") {
        return host === "claude"
          ? command(
              0,
              JSON.stringify([
                {
                  id: "commonwealth@commonwealth",
                  enabled: true,
                  installPath: CLAUDE_ROOT,
                },
              ]),
            )
          : command(
              0,
              JSON.stringify({
                installed: [
                  {
                    pluginId: "commonwealth@commonwealth",
                    name: "commonwealth",
                    marketplaceName: "commonwealth",
                    version: "0.1.12",
                    enabled: true,
                    source: { source: "local", path: "/marketplace/packages/plugin" },
                  },
                ],
              }),
            );
      }
      if (args[0] === "mcp") {
        // MCP detail can contain secrets. The implementation must consume only this status.
        return command(0, '{"env":{"API_TOKEN":"never-print-this"}}');
      }
      if (args[0] === "--version") return command(0, `${host} 1.2.3`);
      return command(1);
    }),
    readText: vi.fn(async (file) => files.get(file) ?? null),
    probeCurate: vi.fn(async () => ({
      kind: "vendored",
      command: "node /plugin/vendor/curate/index.js",
      ok: true,
      code: 0,
      version: "0.1.12",
    })),
    probeExtractor: vi.fn(async () => true),
    ...overrides,
  };
}

const find = (checks: Awaited<ReturnType<typeof diagnoseHostIntegrations>>, id: string) =>
  checks.find((check) => check.id === id)!;

describe("host integration diagnostics (#226)", () => {
  it("parses exact installed entries and ignores merely available Codex plugins", () => {
    expect(
      parseClaudePluginList(
        JSON.stringify([
          { id: "not-commonwealth", installPath: "/wrong" },
          { id: "commonwealth@commonwealth", enabled: true, installPath: CLAUDE_ROOT },
        ]),
      ),
    ).toEqual({ enabled: true, root: CLAUDE_ROOT });
    expect(
      parseCodexPluginList(
        JSON.stringify({
          installed: [],
          available: [{ pluginId: "commonwealth@commonwealth", source: { path: CODEX_ROOT } }],
        }),
        CODEX_HOME,
      ),
    ).toBeNull();
  });

  it("reports each host independently and never claims Codex hook trust", async () => {
    const env = healthyEnv();
    const checks = await diagnoseHostIntegrations(env);
    expect(find(checks, "claude-plugin").status).toBe("ok");
    expect(find(checks, "claude-mcp").status).toBe("ok");
    expect(find(checks, "claude-hooks").status).toBe("ok");
    expect(find(checks, "claude-extractor").status).toBe("ok");
    expect(find(checks, "codex-plugin").status).toBe("ok");
    expect(find(checks, "codex-mcp").status).toBe("ok");
    expect(find(checks, "codex-extractor").status).toBe("ok");
    expect(find(checks, "codex-context").status).toBe("ok");

    const hooks = find(checks, "codex-hooks");
    expect(hooks.status).toBe("warn");
    expect(hooks.detail).toContain("cannot be verified noninteractively");
    expect(hooks.detail.toLowerCase()).not.toContain("trusted");
    expect(hooks.fix).toContain("/hooks");
    expect(env.run).toHaveBeenCalledWith("claude", [
      "mcp",
      "get",
      "plugin:commonwealth:commonwealth",
    ]);
    expect(env.run).toHaveBeenCalledWith("codex", ["mcp", "get", "commonwealth", "--json"]);
  });

  it("redacts all MCP output, arguments, and environment values from the report", async () => {
    const files = manifests();
    files.set(
      path.join(CODEX_ROOT, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          commonwealth: {
            command: "npx",
            args: ["--token", "manifest-secret"],
            env: { API_TOKEN: "manifest-env-secret" },
          },
        },
      }),
    );
    const checks = await diagnoseHostIntegrations(healthyEnv({}, files));
    const rendered = JSON.stringify(checks);
    expect(rendered).not.toContain("never-print-this");
    expect(rendered).not.toContain("manifest-secret");
    expect(rendered).not.toContain("manifest-env-secret");
    expect(find(checks, "codex-mcp").detail).toContain(
      "Sensitive MCP configuration was not printed",
    );
  });

  it("does not let a healthy Codex install mask a missing Claude integration", async () => {
    const base = healthyEnv();
    const run = vi.fn((host: string, args: string[]) => {
      if (host === "claude" && args.join(" ") === "plugin list --json") {
        return { status: null, stdout: "", error: true };
      }
      return base.run(host, args);
    });
    const checks = await diagnoseHostIntegrations(healthyEnv({ run }));
    expect(find(checks, "claude-plugin").status).toBe("skip");
    expect(find(checks, "claude-mcp").status).toBe("skip");
    expect(find(checks, "codex-plugin").status).toBe("ok");
    expect(find(checks, "codex-mcp").status).toBe("ok");
  });

  it("gives host-specific installation fixes for missing plugins", async () => {
    const env = healthyEnv({
      run: (host, args) => {
        if (args.join(" ") === "plugin list --json") {
          return command(0, host === "claude" ? "[]" : '{"installed":[]}');
        }
        return command(1);
      },
    });
    const checks = await diagnoseHostIntegrations(env);
    expect(find(checks, "claude-plugin").fix).toContain("claude plugin install");
    expect(find(checks, "codex-plugin").fix).toContain("codex plugin add");
    expect(JSON.stringify(checks)).not.toContain("codex plugin remove");
    expect(find(checks, "claude-extractor").status).toBe("skip");
    expect(find(checks, "codex-extractor").status).toBe("skip");
  });

  it("skips emitted Codex context when Codex is unavailable", async () => {
    const base = healthyEnv();
    const checks = await diagnoseHostIntegrations(
      healthyEnv({
        run: (host, args) =>
          host === "codex" && args.join(" ") === "plugin list --json"
            ? { status: null, stdout: "", error: true }
            : base.run(host, args),
      }),
    );
    expect(find(checks, "codex-context").status).toBe("skip");
  });

  it("fails an invalid host hook manifest without affecting the other host", async () => {
    const files = manifests();
    files.set(
      path.join(CODEX_ROOT, "hooks", "codex-hooks.json"),
      JSON.stringify({ hooks: { SessionStart: [{}], SessionEnd: [{}] } }),
    );
    const checks = await diagnoseHostIntegrations(healthyEnv({}, files));
    expect(find(checks, "codex-hooks").status).toBe("fail");
    expect(find(checks, "codex-hooks").fix).toContain("codex plugin");
    expect(find(checks, "claude-hooks").status).toBe("ok");
  });

  it("fails only the host whose extractor CLI or curate runtime is broken", async () => {
    const base = healthyEnv();
    const run = vi.fn((host: string, args: string[]) => {
      if (host === "codex" && args[0] === "--version") return command(127);
      return base.run(host, args);
    });
    const checks = await diagnoseHostIntegrations(healthyEnv({ run }));
    expect(find(checks, "codex-extractor").status).toBe("fail");
    expect(find(checks, "codex-extractor").detail).toContain("runtime failed");
    expect(find(checks, "claude-extractor").status).toBe("ok");
  });

  it("fails an extractor with a missing schema or unloadable adapter", async () => {
    const files = manifests();
    files.delete(path.join(CODEX_ROOT, "hooks", "extraction-schema.json"));
    const missingSchema = await diagnoseHostIntegrations(healthyEnv({}, files));
    expect(find(missingSchema, "codex-extractor").status).toBe("fail");
    expect(find(missingSchema, "claude-extractor").status).toBe("ok");

    const unloadable = await diagnoseHostIntegrations(
      healthyEnv({ probeExtractor: async (root) => root !== CODEX_ROOT }),
    );
    expect(find(unloadable, "codex-extractor").status).toBe("fail");
    expect(find(unloadable, "claude-extractor").status).toBe("ok");
  });

  it("reports the Codex emitted fallback as missing or malformed without reading its content", async () => {
    const missing = await diagnoseHostIntegrations(
      healthyEnv({
        readText: async (file) =>
          file.endsWith("AGENTS.md") ? null : await healthyEnv().readText(file),
      }),
    );
    expect(find(missing, "codex-context")).toMatchObject({
      status: "warn",
      fix: "commonwealth emit",
    });

    const files = manifests();
    files.set(path.join("/work/project", "AGENTS.md"), `${EMIT_BEGIN}\nsecret`);
    const malformed = await diagnoseHostIntegrations(healthyEnv({}, files));
    expect(find(malformed, "codex-context").detail).toContain("incomplete");
    expect(JSON.stringify(malformed)).not.toContain("secret");
  });
});
