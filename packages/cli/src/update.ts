import { spawnSync } from "node:child_process";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultServiceDeps, restartIfInstalled } from "./service.js";

/**
 * `commonwealth --version` / `commonwealth update` + the update-available notice (#161).
 *
 * The CLI is npm-first (`npm i -g @cmnwlth/cli`, `npx @cmnwlth/cli`), so "update" means the
 * npm registry's `latest` dist-tag. Three install kinds behave differently:
 *  - a global npm/pnpm install can be updated in place (`<pm> install/add -g`),
 *  - a workspace checkout (this monorepo) updates via git, not the registry,
 *  - an `npx` run has no durable install to update — only guidance.
 *
 * The passive notice must NEVER get in the way: stderr-only, TTY-only, skipped in CI and via
 * `COMMONWEALTH_NO_UPDATE_CHECK`, one registry hit per day (cached, sibling of the scope
 * config), short timeout, and every failure path is silent.
 */

/** The npm package the `commonwealth` bin ships in. */
export const CLI_PACKAGE = "@cmnwlth/cli";

/** How long a cached registry answer stays fresh (one day). */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Registry timeout for the passive per-day check; failing fast beats a snappy notice. */
const NOTICE_TIMEOUT_MS = 1_500;

/** Registry timeout for the explicit `update` command, where the user is waiting on purpose. */
const UPDATE_TIMEOUT_MS = 8_000;

/**
 * The installed CLI version, read from this package's own package.json. Both the bundled
 * `dist/index.js` and the source `src/update.ts` sit one level below the package root, so the
 * relative walk works in production and in source-aliased tests alike.
 */
export function cliVersion(): string {
  const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
  if (typeof pkg.version !== "string") throw new Error(`no version in ${pkgPath}`);
  return pkg.version;
}

/** Parse `X.Y.Z` (ignoring any `-prerelease`/`+build`) into numbers; null when not semver. */
function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when `candidate` is a strictly newer semver than `current`. Unparseable → false. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  if (!a || !b) return false;
  const num = ([maj, min, pat]: [number, number, number]): number => maj * 1e6 + min * 1e3 + pat;
  return num(a) > num(b);
}

/**
 * The `latest` dist-tag version of `pkg` from the npm registry, or null on ANY failure
 * (offline, timeout, 404, bad JSON). Callers treat null as "don't know" — never an error.
 */
export async function fetchLatestVersion(pkg: string, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

/** How this CLI process is installed, which decides what `update` can do. */
export type InstallKind = "workspace" | "npx" | "pnpm-global" | "npm-global";

/**
 * Classify the running install by the resolved location of this module: a `pnpm-workspace.yaml`
 * ancestor means the monorepo checkout; an `_npx` path segment means an ephemeral npx cache; a
 * `pnpm` path segment (pnpm's global dir layout) means `pnpm add -g`; anything else is assumed
 * to be a plain global npm install.
 */
export function detectInstallKind(moduleUrl = import.meta.url): InstallKind {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  for (let dir = moduleDir; ;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return "workspace";
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const segments = moduleDir.split(path.sep);
  if (segments.includes("_npx")) return "npx";
  if (segments.includes("pnpm")) return "pnpm-global";
  return "npm-global";
}

/** The plugin id (plugin@marketplace) Claude Code knows the Commonwealth plugin by. */
export const PLUGIN_ID = "commonwealth@commonwealth";
export const PLUGIN_NAME = "commonwealth";

/** Agent integrations `commonwealth update` can refresh. Default remains Claude for compatibility. */
export type UpdateTarget = "claude" | "codex" | "both";
export type UpdateHost = Exclude<UpdateTarget, "both">;

export interface UpdateOptions {
  agent?: UpdateTarget;
}

/**
 * Outcome of refreshing the Claude Code plugin (hooks + MCP server), a SECOND artifact that
 * `commonwealth update` covers alongside the npm CLI. `ran: false` means we deliberately didn't
 * run (no `claude` CLI, or the plugin isn't installed) — never an error for a CLI-only user.
 */
export interface PluginUpdateResult {
  ran: boolean;
  ok: boolean;
  /** A discovery/probe failure is fatal even though no mutating command ran. */
  failed?: boolean;
  detail?: string;
  /** Exact host-specific command(s) the user can run to repair this integration. */
  repair?: string;
}

/** Minimal captured command result; raw output is parsed but never rendered to logs. */
export interface UpdateCommandResult {
  status: number | null;
  stdout?: string;
  error?: { code?: string };
}

export type UpdateCommandRunner = (command: string, args: string[]) => UpdateCommandResult;

/** The injected effects of {@link runUpdate}; wired for real in {@link defaultUpdateDeps}. */
export interface UpdateDeps {
  /** The installed CLI version. */
  currentVersion(): string;
  /** Latest published version of `pkg`, or null when the registry can't answer. */
  fetchLatest(pkg: string, timeoutMs: number): Promise<string | null>;
  /** How this process is installed. */
  installKind(): InstallKind;
  /** Run the package-manager install for `spec`; ok=false carries a short reason. */
  install(pm: "npm" | "pnpm", spec: string): { ok: boolean; detail?: string };
  /** Refresh one host plugin. The optional host keeps older injected deps source-compatible. */
  updatePlugin(host?: UpdateHost): PluginUpdateResult;
  /** Restart the background sync service if installed (so the new binary loads); returns whether it did. */
  restartService(): Promise<boolean>;
  /** Progress/diagnostic sink (stderr in production). */
  log(m: string): void;
}

/**
 * Refresh one selected host plugin (hooks + MCP server) — the second half of "update Commonwealth".
 * The CLI (npm) and the plugin (Claude Code marketplace) are independent artifacts, so the plugin
 * is refreshed regardless of whether the CLI itself needed updating: a user can have a current CLI
 * but a stale installed plugin (exactly the drift that leaves capture running old hook code).
 *
 * For a `workspace`/`npx` process the plugin isn't durably managed by this install (a workspace
 * plugin is copied from the local checkout, which must be rebuilt first), so we print the command
 * instead of running it. For a global install we run `claude plugin update` best-effort. A skip
 * (no `claude`, or plugin not installed) is fine and never fails the command; a genuine failure
 * of the update itself returns 1 so the drift is visible.
 *
 * @returns Exit-code contribution: 0 unless the plugin update actually ran and failed.
 */
function refreshPlugin(deps: UpdateDeps, kind: InstallKind, host: UpdateHost): number {
  if (kind === "workspace" || kind === "npx") {
    if (host === "claude") {
      deps.log(
        "update: also refresh the Claude Code plugin (hooks + MCP server), then restart Claude Code:\n" +
          `  claude plugin update ${PLUGIN_ID}`,
      );
    } else {
      deps.log(
        "update: also refresh the Codex plugin (hooks + MCP server), then restart Codex:\n" +
          `  codex plugin marketplace upgrade commonwealth\n` +
          `  codex plugin add ${PLUGIN_ID}`,
      );
    }
    return 0;
  }
  let res: PluginUpdateResult;
  try {
    res = deps.updatePlugin(host);
  } catch {
    res = {
      ran: false,
      ok: false,
      failed: true,
      detail: `${host} updater threw unexpectedly`,
      repair:
        host === "claude"
          ? `claude plugin update ${PLUGIN_ID}`
          : `codex plugin marketplace upgrade commonwealth\ncodex plugin add ${PLUGIN_ID}`,
    };
  }
  const repair = res.repair ? ` Repair with:\n  ${res.repair.replaceAll("\n", "\n  ")}` : "";
  if (!res.ran) {
    const verb = res.failed ? "plugin refresh failed" : "skipped plugin refresh";
    deps.log(`update: ${verb}${res.detail ? ` (${res.detail})` : ""} [${host}].${repair}`);
    return res.failed ? 1 : 0;
  }
  if (!res.ok) {
    deps.log(
      `update: plugin refresh failed${res.detail ? ` (${res.detail})` : ""} [${host}].${repair}`,
    );
    return 1;
  }
  deps.log(
    host === "claude"
      ? "update: refreshed the Claude Code plugin — restart Claude Code to apply."
      : "update: refreshed the Codex plugin — restart Codex to apply.",
  );
  return 0;
}

function selectedHosts(target: UpdateTarget): UpdateHost[] {
  return target === "both" ? ["claude", "codex"] : [target];
}

/**
 * `commonwealth update` — resolve the latest published version and update in place when the
 * install kind allows it, otherwise print the exact command that does. Then refresh the Claude
 * Code plugin (hooks + MCP server) too, so one command covers both artifacts (see
 * {@link refreshPlugin}).
 *
 * @returns Exit code: 0 up-to-date/updated/guidance printed, 1 registry unreachable, CLI install
 *   failed, or the plugin refresh ran and failed.
 */
export async function runUpdate(deps: UpdateDeps, options: UpdateOptions = {}): Promise<number> {
  const target = options.agent ?? "claude";
  const current = deps.currentVersion();
  const latest = await deps.fetchLatest(CLI_PACKAGE, UPDATE_TIMEOUT_MS);
  const kind = deps.installKind();
  let exitCode = 0;
  let installedCli = false;

  if (latest === null) {
    deps.log(`update: could not reach the npm registry (current: v${current}). Try again later.`);
    exitCode = 1;
  } else if (!isNewer(latest, current)) {
    deps.log(`update: already up to date (v${current}; latest published is v${latest}).`);
  } else {
    deps.log(`update: v${current} -> v${latest}`);
    switch (kind) {
      case "workspace":
        deps.log(
          "update: running from a workspace checkout — update the CLI with:\n" +
            "  git pull && pnpm install && pnpm build",
        );
        break;
      case "npx":
        deps.log(
          "update: running via npx, which has no durable install to update. Pin the latest with\n" +
            `  npx ${CLI_PACKAGE}@latest <command>   — or install it: npm i -g ${CLI_PACKAGE}`,
        );
        break;
      case "pnpm-global":
      case "npm-global": {
        const pm = kind === "pnpm-global" ? "pnpm" : "npm";
        const res = deps.install(pm, `${CLI_PACKAGE}@${latest}`);
        if (!res.ok) {
          deps.log(`update: install failed${res.detail ? ` (${res.detail})` : ""}.`);
          exitCode = 1;
        } else {
          installedCli = true;
          deps.log(`update: updated to v${latest}.`);
        }
        break;
      }
    }
  }

  // CLI and host integrations are independent artifacts. Always attempt every selected host,
  // even when the registry, package-manager install, or another host refresh failed.
  for (const host of selectedHosts(target)) {
    exitCode = Math.max(exitCode, refreshPlugin(deps, kind, host));
  }

  if (installedCli && (await deps.restartService())) {
    deps.log("update: restarted the background sync service to load the new binary.");
  }
  return exitCode;
}

function safeName(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._-]+$/.test(value) ? value : null;
}

/** Exact installed-plugin lookup from Codex's structured output; never scans human text. */
export function parseCodexInstalledPlugin(stdout: string): {
  marketplace: string;
  selector: string;
} | null {
  const parsed = JSON.parse(stdout) as {
    installed?: Array<{ pluginId?: unknown; name?: unknown; marketplaceName?: unknown }>;
  };
  if (!Array.isArray(parsed.installed)) throw new Error("invalid Codex plugin list shape");
  for (const row of parsed.installed) {
    if (row?.name !== PLUGIN_NAME) continue;
    const marketplace = safeName(row.marketplaceName);
    if (!marketplace || row.pluginId !== `${PLUGIN_NAME}@${marketplace}`) return null;
    return { marketplace, selector: `${PLUGIN_NAME}@${marketplace}` };
  }
  return null;
}

/** Exact marketplace lookup from Codex's structured output. */
export function parseCodexMarketplaceKind(
  stdout: string,
  marketplace: string,
): "git" | "local" | null {
  const parsed = JSON.parse(stdout) as {
    marketplaces?: Array<{
      name?: unknown;
      marketplaceSource?: { sourceType?: unknown };
    }>;
  };
  if (!Array.isArray(parsed.marketplaces)) throw new Error("invalid Codex marketplace list shape");
  const row = parsed.marketplaces.find((candidate) => candidate?.name === marketplace);
  const kind = row?.marketplaceSource?.sourceType;
  return kind === "git" || kind === "local" ? kind : null;
}

/** Claude's supported direct update path, with structured installed-plugin discovery. */
export function updateClaudePlugin(run: UpdateCommandRunner): PluginUpdateResult {
  const repair = `claude plugin update ${PLUGIN_ID}`;
  const list = run("claude", ["plugin", "list", "--json"]);
  if (list.error?.code === "ENOENT") {
    return {
      ran: false,
      ok: false,
      detail: "claude CLI not found",
      repair: `install Claude Code, then run commonwealth update --agent claude`,
    };
  }
  if (list.status !== 0) {
    return {
      ran: false,
      ok: false,
      failed: true,
      detail: `claude plugin list exited with code ${list.status ?? "null"}`,
      repair,
    };
  }
  let installed = false;
  try {
    const parsed = JSON.parse(list.stdout ?? "") as
      | Array<{ id?: unknown; name?: unknown; plugin?: unknown }>
      | { plugins?: Array<{ id?: unknown; name?: unknown; plugin?: unknown }> };
    const rows = Array.isArray(parsed) ? parsed : (parsed.plugins ?? []);
    installed = rows.some((row) => {
      const id = typeof row?.id === "string" ? row.id : null;
      return id === PLUGIN_ID || row?.plugin === PLUGIN_ID;
    });
  } catch {
    return {
      ran: false,
      ok: false,
      failed: true,
      detail: "claude plugin list returned invalid JSON",
      repair,
    };
  }
  if (!installed) {
    return {
      ran: false,
      ok: false,
      detail: `${PLUGIN_ID} not installed`,
      repair: `claude plugin install ${PLUGIN_ID}`,
    };
  }

  const update = run("claude", ["plugin", "update", PLUGIN_ID]);
  if (update.status !== 0) {
    return {
      ran: true,
      ok: false,
      detail: `claude plugin update exited with code ${update.status ?? "null"}`,
      repair,
    };
  }
  return { ran: true, ok: true };
}

/**
 * Codex update path: discover the exact installed marketplace, refresh it only when Git-backed,
 * then idempotently `plugin add` the same selector. Never remove/re-add the plugin.
 */
export function updateCodexPlugin(run: UpdateCommandRunner): PluginUpdateResult {
  const genericRepair = `codex plugin marketplace upgrade commonwealth\ncodex plugin add ${PLUGIN_ID}`;
  const installedList = run("codex", ["plugin", "list", "--json"]);
  if (installedList.error?.code === "ENOENT") {
    return {
      ran: false,
      ok: false,
      detail: "codex CLI not found",
      repair: `install Codex, then run commonwealth update --agent codex`,
    };
  }
  if (installedList.status !== 0) {
    return {
      ran: false,
      ok: false,
      failed: true,
      detail: `codex plugin list exited with code ${installedList.status ?? "null"}`,
      repair: genericRepair,
    };
  }

  let installed;
  try {
    installed = parseCodexInstalledPlugin(installedList.stdout ?? "");
  } catch {
    return {
      ran: false,
      ok: false,
      failed: true,
      detail: "codex plugin list returned invalid JSON",
      repair: genericRepair,
    };
  }
  if (!installed) {
    return {
      ran: false,
      ok: false,
      detail: `${PLUGIN_NAME} plugin not installed`,
      repair: `codex plugin add ${PLUGIN_ID}`,
    };
  }

  const repair = `codex plugin marketplace upgrade ${installed.marketplace}\ncodex plugin add ${installed.selector}`;
  const marketplaceList = run("codex", ["plugin", "marketplace", "list", "--json"]);
  if (marketplaceList.status !== 0) {
    return {
      ran: false,
      ok: false,
      failed: true,
      detail: `codex marketplace list exited with code ${marketplaceList.status ?? "null"}`,
      repair,
    };
  }
  let kind;
  try {
    kind = parseCodexMarketplaceKind(marketplaceList.stdout ?? "", installed.marketplace);
  } catch {
    return {
      ran: false,
      ok: false,
      failed: true,
      detail: "codex marketplace list returned invalid JSON",
      repair,
    };
  }
  if (kind === null) {
    return {
      ran: false,
      ok: false,
      failed: true,
      detail: `could not safely resolve marketplace ${installed.marketplace}`,
      repair,
    };
  }

  const effectiveRepair = kind === "git" ? repair : `codex plugin add ${installed.selector}`;

  let upgradeFailed = false;
  if (kind === "git") {
    const upgrade = run("codex", ["plugin", "marketplace", "upgrade", installed.marketplace]);
    upgradeFailed = upgrade.status !== 0;
  }
  // `plugin add` is Codex's idempotent refresh/install operation. Attempt it even when the Git
  // marketplace refresh failed so one broken step cannot prevent the remaining repair attempt.
  const add = run("codex", ["plugin", "add", installed.selector]);
  if (upgradeFailed || add.status !== 0) {
    const detail = [
      upgradeFailed ? "codex marketplace upgrade failed" : null,
      add.status !== 0 ? `codex plugin add exited with code ${add.status ?? "null"}` : null,
    ]
      .filter((part): part is string => part !== null)
      .join("; ");
    return { ran: true, ok: false, detail, repair: effectiveRepair };
  }
  return { ran: true, ok: true };
}

/** The real {@link UpdateDeps}: registry fetch, install-kind sniffing, a spawned installer. */
export function defaultUpdateDeps(): UpdateDeps {
  const runHostCommand: UpdateCommandRunner = (command, args) => {
    const res = spawnSync(command, args, { encoding: "utf8" });
    return {
      status: res.status,
      stdout: typeof res.stdout === "string" ? res.stdout : "",
      error: res.error ? { code: (res.error as NodeJS.ErrnoException).code } : undefined,
    };
  };
  return {
    currentVersion: cliVersion,
    fetchLatest: fetchLatestVersion,
    installKind: () => detectInstallKind(),
    install: (pm, spec) => {
      const args = pm === "pnpm" ? ["add", "-g", spec] : ["install", "-g", spec];
      const res = spawnSync(pm, args, { stdio: "inherit" });
      if (res.error) return { ok: false, detail: res.error.message };
      if (res.status !== 0) return { ok: false, detail: `${pm} exited with code ${res.status}` };
      return { ok: true };
    },
    updatePlugin: (host = "claude") =>
      host === "claude" ? updateClaudePlugin(runHostCommand) : updateCodexPlugin(runHostCommand),
    restartService: () => restartIfInstalled(defaultServiceDeps()),
    log: (m) => {
      process.stderr.write(`${m}\n`);
    },
  };
}

/** Shape of the on-disk update-check cache (one registry answer per day). */
interface UpdateCheckCache {
  checkedAt: number;
  latest: string | null;
}

/**
 * Default cache location: `update-check.json` next to the per-user scope config, so tests that
 * redirect `COMMONWEALTH_CONFIG` redirect this too and never touch the real `~/.commonwealth`.
 */
export function defaultUpdateCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const configPath = env.COMMONWEALTH_CONFIG ?? path.join(os.homedir(), ".commonwealth", "x");
  return path.join(path.dirname(configPath), "update-check.json");
}

/** The injected environment of {@link maybeNotifyUpdate}. */
export interface UpdateNoticeDeps {
  currentVersion(): string;
  fetchLatest(pkg: string, timeoutMs: number): Promise<string | null>;
  /** Cache file path (see {@link defaultUpdateCachePath}). */
  cachePath: string;
  /** Whether stderr is a TTY — the notice is for humans at a terminal only. */
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
  now(): number;
  log(m: string): void;
}

/**
 * Print a one-line "update available" notice when a newer CLI is published. Hits the registry
 * at most once per {@link CACHE_TTL_MS} (a failed check also backs off, so being offline costs
 * one timeout a day, not one per command). Silent on every failure path — a broken cache file,
 * an unreachable registry, or an unwritable directory must never affect the command that ran.
 */
export async function maybeNotifyUpdate(deps: UpdateNoticeDeps): Promise<void> {
  try {
    if (!deps.isTTY) return;
    if (deps.env.COMMONWEALTH_NO_UPDATE_CHECK || deps.env.CI) return;

    let cache: UpdateCheckCache | null = null;
    try {
      const parsed = JSON.parse(await fs.readFile(deps.cachePath, "utf8")) as UpdateCheckCache;
      if (typeof parsed.checkedAt === "number") cache = parsed;
    } catch {
      cache = null;
    }

    let latest = cache?.latest ?? null;
    if (!cache || deps.now() - cache.checkedAt > CACHE_TTL_MS) {
      const fetched = await deps.fetchLatest(CLI_PACKAGE, NOTICE_TIMEOUT_MS);
      // Record the attempt either way: a null answer backs off for a day instead of retrying
      // (and timing out) on every single command while offline.
      latest = fetched ?? latest;
      const next: UpdateCheckCache = { checkedAt: deps.now(), latest };
      await fs.mkdir(path.dirname(deps.cachePath), { recursive: true });
      await fs.writeFile(deps.cachePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    }

    const current = deps.currentVersion();
    if (latest !== null && isNewer(latest, current)) {
      deps.log(
        `[commonwealth] update available: v${current} -> v${latest} — run \`commonwealth update\` ` +
          `(COMMONWEALTH_NO_UPDATE_CHECK=1 to silence)`,
      );
    }
  } catch {
    // Never let the notice break or noise up the command that just ran.
  }
}

/** The real {@link UpdateNoticeDeps}. */
export function defaultUpdateNoticeDeps(): UpdateNoticeDeps {
  return {
    currentVersion: cliVersion,
    fetchLatest: fetchLatestVersion,
    cachePath: defaultUpdateCachePath(),
    isTTY: process.stderr.isTTY === true,
    env: process.env,
    now: () => Date.now(),
    log: (m) => {
      process.stderr.write(`${m}\n`);
    },
  };
}
