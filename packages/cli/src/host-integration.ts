import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { EMIT_BEGIN, EMIT_END } from "@cmnwlth/core";
import type { CurateRuntimeProbe, DoctorCheck } from "./doctor.js";

/** Agent hosts whose Commonwealth integration can be inspected independently. */
export type IntegrationHost = "claude" | "codex";

/** Deliberately narrow command result: diagnostics never retain or surface stderr. */
export interface SafeCommandResult {
  status: number | null;
  stdout: string;
  /** Spawn failed (normally executable not found). The error text is intentionally discarded. */
  error: boolean;
}

/** Injectable ambient surfaces for host integration diagnostics. */
export interface HostIntegrationEnv {
  cwd: string;
  codexHome: string;
  run: (command: string, args: string[]) => SafeCommandResult;
  readText: (file: string) => Promise<string | null>;
  probeCurate: (pluginRoot: string) => Promise<CurateRuntimeProbe | null>;
  probeExtractor: (pluginRoot: string) => Promise<boolean>;
}

interface InstalledPlugin {
  enabled: boolean;
  root: string | null;
}

interface PluginProbe {
  available: boolean;
  listHealthy: boolean;
  plugin: InstalledPlugin | null;
}

interface PluginListRow {
  id?: unknown;
  pluginId?: unknown;
  name?: unknown;
  enabled?: unknown;
  installPath?: unknown;
  marketplaceName?: unknown;
  version?: unknown;
  source?: unknown;
}

const HOSTS: readonly IntegrationHost[] = ["claude", "codex"];

function pluginIdMatches(row: PluginListRow): boolean {
  const values = [row.id, row.pluginId, row.name];
  return values.some(
    (value) =>
      typeof value === "string" &&
      (value === "commonwealth" || value.split("@")[0] === "commonwealth"),
  );
}

function pluginRoot(row: PluginListRow): string | null {
  if (typeof row.installPath === "string" && row.installPath.length > 0) return row.installPath;
  return null;
}

function safePathPart(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._-]+$/.test(value) ? value : null;
}

function codexPluginRoot(row: PluginListRow, codexHome: string): string | null {
  const marketplace = safePathPart(row.marketplaceName);
  const name = safePathPart(row.name);
  const version = safePathPart(row.version);
  return marketplace && name && version
    ? path.join(codexHome, "plugins", "cache", marketplace, name, version)
    : null;
}

/** Parse Claude's supported plugin-list JSON shapes without fuzzy text matching. */
export function parseClaudePluginList(stdout: string): InstalledPlugin | null {
  const parsed: unknown = JSON.parse(stdout);
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === "object" &&
        "plugins" in parsed &&
        Array.isArray((parsed as { plugins?: unknown }).plugins)
      ? ((parsed as { plugins: PluginListRow[] }).plugins ?? [])
      : [];
  const row = rows.find(
    (value): value is PluginListRow =>
      value !== null && typeof value === "object" && pluginIdMatches(value as PluginListRow),
  );
  return row ? { enabled: row.enabled !== false, root: pluginRoot(row) } : null;
}

/** Parse Codex's installed-plugin list only; marketplace availability is not installation. */
export function parseCodexPluginList(stdout: string, codexHome: string): InstalledPlugin | null {
  const parsed: unknown = JSON.parse(stdout);
  const rows =
    parsed &&
    typeof parsed === "object" &&
    "installed" in parsed &&
    Array.isArray((parsed as { installed?: unknown }).installed)
      ? ((parsed as { installed: PluginListRow[] }).installed ?? [])
      : [];
  const row = rows.find((value) => value && typeof value === "object" && pluginIdMatches(value));
  return row ? { enabled: row.enabled !== false, root: codexPluginRoot(row, codexHome) } : null;
}

function installFix(host: IntegrationHost): string {
  return host === "claude"
    ? "claude plugin marketplace add kristoffeys/commonwealth && claude plugin install commonwealth@commonwealth"
    : "codex plugin marketplace add kristoffeys/commonwealth && codex plugin add commonwealth@commonwealth";
}

function updateFix(host: IntegrationHost): string {
  return host === "claude"
    ? "claude plugin update commonwealth@commonwealth"
    : "codex plugin marketplace upgrade commonwealth && codex plugin add commonwealth@commonwealth";
}

function safeDisplayPath(value: string): string {
  return [...value]
    .map((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127 ? " " : char;
    })
    .join("")
    .trim();
}

function safeVersion(stdout: string): string {
  return stdout.match(/\b\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?\b/)?.[0] ?? "version OK";
}

function parsePluginProbe(
  host: IntegrationHost,
  result: SafeCommandResult,
  codexHome: string,
): PluginProbe {
  if (result.error) return { available: false, listHealthy: false, plugin: null };
  if (result.status !== 0) return { available: true, listHealthy: false, plugin: null };
  try {
    return {
      available: true,
      listHealthy: true,
      plugin:
        host === "claude"
          ? parseClaudePluginList(result.stdout)
          : parseCodexPluginList(result.stdout, codexHome),
    };
  } catch {
    return { available: true, listHealthy: false, plugin: null };
  }
}

async function readJson(
  env: HostIntegrationEnv,
  file: string,
): Promise<Record<string, unknown> | null> {
  const raw = await env.readText(file);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Resolve a manifest-owned relative path while preventing traversal outside the plugin root. */
function bundlePath(root: string, relative: unknown): string | null {
  if (typeof relative !== "string" || !relative.startsWith("./")) return null;
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`)
    ? resolved
    : null;
}

async function manifestFor(
  host: IntegrationHost,
  root: string,
  env: HostIntegrationEnv,
): Promise<Record<string, unknown> | null> {
  return await readJson(
    env,
    path.join(root, host === "claude" ? ".claude-plugin" : ".codex-plugin", "plugin.json"),
  );
}

async function pluginCheck(host: IntegrationHost, probe: PluginProbe): Promise<DoctorCheck> {
  const label = `${host === "claude" ? "Claude" : "Codex"} plugin`;
  if (!probe.available) {
    return {
      id: `${host}-plugin`,
      label,
      status: "skip",
      detail: `Can't verify — no \`${host}\` CLI on PATH.`,
    };
  }
  if (!probe.listHealthy) {
    return {
      id: `${host}-plugin`,
      label,
      status: "skip",
      detail: `The \`${host} plugin list --json\` probe failed or returned invalid JSON; installation was not inferred.`,
      fix: `${host} plugin --help   (update ${host} if structured plugin listing is unavailable)`,
    };
  }
  if (!probe.plugin) {
    return {
      id: `${host}-plugin`,
      label,
      status: "warn",
      detail: "Commonwealth is not installed for this host.",
      fix: installFix(host),
    };
  }
  if (!probe.plugin.enabled) {
    return {
      id: `${host}-plugin`,
      label,
      status: "warn",
      detail: "Commonwealth is installed but disabled for this host.",
      fix:
        host === "claude" ? "claude plugin enable commonwealth@commonwealth" : updateFix("codex"),
    };
  }
  return {
    id: `${host}-plugin`,
    label,
    status: "ok",
    detail: probe.plugin.root
      ? `Commonwealth is installed and enabled from ${safeDisplayPath(probe.plugin.root)}.`
      : "Commonwealth is installed and enabled; this host did not expose its install path.",
  };
}

async function mcpCheck(
  host: IntegrationHost,
  probe: PluginProbe,
  env: HostIntegrationEnv,
): Promise<DoctorCheck> {
  const id = `${host}-mcp`;
  const label = `${host === "claude" ? "Claude" : "Codex"} MCP`;
  if (!probe.plugin?.enabled) {
    return {
      id,
      label,
      status: "skip",
      detail: "Not checked because the Commonwealth plugin is not installed and enabled.",
    };
  }

  let declarationHealthy: boolean | null = null;
  if (probe.plugin.root) {
    const manifest = await manifestFor(host, probe.plugin.root, env);
    const mcpFile = manifest && bundlePath(probe.plugin.root, manifest.mcpServers);
    const mcp = mcpFile ? await readJson(env, mcpFile) : null;
    const servers =
      mcp?.mcpServers && typeof mcp.mcpServers === "object"
        ? (mcp.mcpServers as Record<string, unknown>)
        : null;
    const commonwealth = servers?.commonwealth;
    declarationHealthy = Boolean(
      commonwealth &&
      typeof commonwealth === "object" &&
      "command" in commonwealth &&
      typeof (commonwealth as { command?: unknown }).command === "string" &&
      (commonwealth as { command: string }).command.length > 0,
    );
    if (!declarationHealthy) {
      return {
        id,
        label,
        status: "fail",
        detail: "The installed plugin's Commonwealth MCP declaration is missing or invalid.",
        fix: updateFix(host),
      };
    }
  }

  // Only status is consumed. MCP configuration output can contain command arguments, environment
  // variables, headers, and bearer tokens, so it must never enter a DoctorCheck or an error log.
  const serverName = host === "claude" ? "plugin:commonwealth:commonwealth" : "commonwealth";
  const live = env.run(host, ["mcp", "get", serverName, ...(host === "codex" ? ["--json"] : [])]);
  if (live.error || live.status !== 0) {
    return {
      id,
      label,
      status: "fail",
      detail:
        "The host does not expose the plugin's `commonwealth` MCP server. Probe output was redacted.",
      fix: `${updateFix(host)}   (then restart ${host === "claude" ? "Claude Code" : "Codex"})`,
    };
  }
  return {
    id,
    label,
    status: "ok",
    detail:
      declarationHealthy === true
        ? "The plugin declaration is valid and the host exposes `commonwealth`. Sensitive MCP configuration was not printed."
        : "The host exposes `commonwealth`; its install root was unavailable for static validation. Sensitive MCP configuration was not printed.",
  };
}

function validHookEvents(config: Record<string, unknown> | null, expected: string[]): boolean {
  if (!config || !config.hooks || typeof config.hooks !== "object") return false;
  const hooks = config.hooks as Record<string, unknown>;
  return expected.every((event) => {
    const groups = hooks[event];
    return (
      Array.isArray(groups) &&
      groups.length > 0 &&
      groups.some((group) => {
        if (!group || typeof group !== "object" || !("hooks" in group)) return false;
        const handlers = (group as { hooks?: unknown }).hooks;
        return (
          Array.isArray(handlers) &&
          handlers.some(
            (handler) =>
              handler !== null &&
              typeof handler === "object" &&
              (handler as { type?: unknown }).type === "command" &&
              typeof (handler as { command?: unknown }).command === "string" &&
              (handler as { command: string }).command.length > 0,
          )
        );
      })
    );
  });
}

async function hooksCheck(
  host: IntegrationHost,
  probe: PluginProbe,
  env: HostIntegrationEnv,
): Promise<DoctorCheck> {
  const id = `${host}-hooks`;
  const label = `${host === "claude" ? "Claude" : "Codex"} hooks`;
  if (!probe.plugin?.enabled) {
    return {
      id,
      label,
      status: "skip",
      detail: "Not checked because the Commonwealth plugin is not installed and enabled.",
    };
  }
  if (!probe.plugin.root) {
    return {
      id,
      label,
      status: "warn",
      detail:
        "The host did not expose the plugin root, so lifecycle declarations could not be inspected.",
      fix: updateFix(host),
    };
  }

  const manifest = await manifestFor(host, probe.plugin.root, env);
  const hooksFile =
    host === "claude"
      ? path.join(probe.plugin.root, "hooks", "hooks.json")
      : manifest
        ? bundlePath(probe.plugin.root, manifest.hooks)
        : null;
  const hooks = hooksFile ? await readJson(env, hooksFile) : null;
  const expected =
    host === "claude"
      ? ["SessionStart", "UserPromptSubmit", "PreCompact", "SessionEnd"]
      : ["SessionStart", "UserPromptSubmit", "PreCompact", "Stop"];
  const valid = validHookEvents(hooks, expected);
  const manifestSelectionHealthy =
    host === "claude" ? manifest !== null && manifest.hooks === undefined : hooksFile !== null;
  const hasUnsupportedSessionEnd =
    host === "codex" &&
    Boolean(hooks?.hooks && typeof hooks.hooks === "object" && "SessionEnd" in hooks.hooks);
  if (!manifestSelectionHealthy || !valid || hasUnsupportedSessionEnd) {
    return {
      id,
      label,
      status: "fail",
      detail: `The installed ${host} lifecycle manifest is missing required events or contains an incompatible event.`,
      fix: updateFix(host),
    };
  }

  if (host === "codex") {
    return {
      id,
      label,
      status: "warn",
      detail:
        "Lifecycle definitions are present. Hook trust cannot be verified noninteractively, so they may still be skipped.",
      fix: "In Codex, run `/hooks`, review Commonwealth, and trust the current definitions.",
    };
  }
  return {
    id,
    label,
    status: "ok",
    detail: "SessionStart, UserPromptSubmit, PreCompact, and SessionEnd are declared.",
  };
}

async function extractorCheck(
  host: IntegrationHost,
  probe: PluginProbe,
  env: HostIntegrationEnv,
): Promise<DoctorCheck> {
  const id = `${host}-extractor`;
  const label = `${host === "claude" ? "Claude" : "Codex"} extractor`;
  if (!probe.plugin?.enabled) {
    return {
      id,
      label,
      status: "skip",
      detail: "Not checked because the Commonwealth plugin is not installed and enabled.",
    };
  }
  if (!probe.plugin.root) {
    return {
      id,
      label,
      status: "warn",
      detail:
        "The host did not expose the plugin root, so the live extraction path could not be inspected.",
      fix: updateFix(host),
    };
  }
  const extraction = await env.readText(path.join(probe.plugin.root, "hooks", "extraction.mjs"));
  if (extraction === null) {
    return {
      id,
      label,
      status: "fail",
      detail: "The installed plugin is missing its host-neutral extraction adapter.",
      fix: updateFix(host),
    };
  }
  const schema = await readJson(
    env,
    path.join(probe.plugin.root, "hooks", "extraction-schema.json"),
  );
  if (schema === null || !(await env.probeExtractor(probe.plugin.root))) {
    return {
      id,
      label,
      status: "fail",
      detail:
        "The installed host-neutral extraction adapter or its response schema is missing or invalid.",
      fix: updateFix(host),
    };
  }

  const hostVersion = env.run(host, ["--version"]);
  if (hostVersion.error || hostVersion.status !== 0) {
    return {
      id,
      label,
      status: "fail",
      detail: `The installed plugin is present, but the \`${host}\` extractor runtime failed its version probe.`,
      fix: `repair or reinstall the ${host} CLI, then run \`${host} --version\``,
    };
  }

  const curate = await env.probeCurate(probe.plugin.root);
  if (curate === null || curate.kind === "unsupported") {
    return {
      id,
      label,
      status: "warn",
      detail: `The ${host} CLI is healthy (${safeVersion(hostVersion.stdout)}), but the installed plugin cannot verify its curate runtime. Capture status was not inferred.`,
      fix: updateFix(host),
    };
  }
  if (!curate.ok) {
    return {
      id,
      label,
      status: "fail",
      detail: `The ${host} CLI is healthy, but the installed plugin's ${curate.kind} curate path failed. Capture is OFF for this host.`,
      fix: updateFix(host),
    };
  }
  const detail = `Live extraction path is ${safeDisplayPath(probe.plugin.root)} using ${host} ${safeVersion(hostVersion.stdout)} and the ${curate.kind} curate runtime.`;
  return {
    id,
    label,
    status: curate.kind === "npx" ? "warn" : "ok",
    detail:
      curate.kind === "npx"
        ? `${detail} Capture still depends on the npm registry/cache fallback.`
        : detail,
  };
}

async function codexContextCheck(
  env: HostIntegrationEnv,
  probe: PluginProbe,
): Promise<DoctorCheck> {
  if (!probe.available) {
    return {
      id: "codex-context",
      label: "Codex context",
      status: "skip",
      detail: "Not checked because the Codex CLI is not available.",
    };
  }
  const agents = await env.readText(path.join(path.resolve(env.cwd), "AGENTS.md"));
  const begin = agents?.includes(EMIT_BEGIN) === true;
  const end = agents?.includes(EMIT_END) === true;
  if (begin && end) {
    return {
      id: "codex-context",
      label: "Codex context",
      status: "ok",
      detail: "AGENTS.md contains the generated Commonwealth fallback block.",
    };
  }
  return {
    id: "codex-context",
    label: "Codex context",
    status: "warn",
    detail:
      begin || end
        ? "AGENTS.md contains an incomplete Commonwealth generated block."
        : "AGENTS.md has no generated Commonwealth fallback block.",
    fix: "commonwealth emit",
  };
}

/** Inspect both host integrations independently and return stable host-prefixed doctor checks. */
export async function diagnoseHostIntegrations(env: HostIntegrationEnv): Promise<DoctorCheck[]> {
  const probes = new Map<IntegrationHost, PluginProbe>();
  for (const host of HOSTS) {
    probes.set(
      host,
      parsePluginProbe(host, env.run(host, ["plugin", "list", "--json"]), env.codexHome),
    );
  }

  const checks: DoctorCheck[] = [];
  for (const host of HOSTS) {
    const probe = probes.get(host)!;
    checks.push(await pluginCheck(host, probe));
    checks.push(await mcpCheck(host, probe, env));
    checks.push(await hooksCheck(host, probe, env));
    checks.push(await extractorCheck(host, probe, env));
  }
  checks.push(await codexContextCheck(env, probes.get("codex")!));
  return checks;
}

/** Real, read-only host diagnostics. Command outputs are captured only for structured parsing. */
export function defaultHostIntegrationEnv(cwd: string): HostIntegrationEnv {
  return {
    cwd,
    codexHome: process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
    run: (command, args) => {
      const result = spawnSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 4 * 1024 * 1024,
      });
      return {
        status: result.status,
        stdout: typeof result.stdout === "string" ? result.stdout : "",
        error: result.error !== undefined,
      };
    },
    readText: async (file) => {
      try {
        return await fs.readFile(file, "utf8");
      } catch {
        return null;
      }
    },
    probeCurate: async (root) => {
      try {
        const hookLib = path.join(root, "hooks", "lib.mjs");
        const mod = (await import(pathToFileURL(hookLib).href)) as {
          probeCurateRuntime?: () => Promise<CurateRuntimeProbe>;
        };
        return typeof mod.probeCurateRuntime === "function" ? await mod.probeCurateRuntime() : null;
      } catch {
        return null;
      }
    },
    probeExtractor: async (root) => {
      try {
        const extraction = path.join(root, "hooks", "extraction.mjs");
        const mod = (await import(pathToFileURL(extraction).href)) as {
          createExtractor?: unknown;
        };
        return typeof mod.createExtractor === "function";
      } catch {
        return false;
      }
    },
  };
}
