import { spawnSync } from "node:child_process";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  /** Progress/diagnostic sink (stderr in production). */
  log(m: string): void;
}

/**
 * `commonwealth update` — resolve the latest published version and update in place when the
 * install kind allows it, otherwise print the exact command that does.
 *
 * @returns Exit code: 0 up-to-date/updated/guidance printed, 1 registry unreachable or install failed.
 */
export async function runUpdate(deps: UpdateDeps): Promise<number> {
  const current = deps.currentVersion();
  const latest = await deps.fetchLatest(CLI_PACKAGE, UPDATE_TIMEOUT_MS);
  if (latest === null) {
    deps.log(`update: could not reach the npm registry (current: v${current}). Try again later.`);
    return 1;
  }
  if (!isNewer(latest, current)) {
    deps.log(`update: already up to date (v${current}; latest published is v${latest}).`);
    return 0;
  }

  deps.log(`update: v${current} -> v${latest}`);
  const kind = deps.installKind();
  switch (kind) {
    case "workspace":
      deps.log(
        "update: running from a workspace checkout — update with:\n" +
          "  git pull && pnpm install && pnpm build",
      );
      return 0;
    case "npx":
      deps.log(
        "update: running via npx, which has no durable install to update. Pin the latest with\n" +
          `  npx ${CLI_PACKAGE}@latest <command>   — or install it: npm i -g ${CLI_PACKAGE}`,
      );
      return 0;
    case "pnpm-global":
    case "npm-global": {
      const pm = kind === "pnpm-global" ? "pnpm" : "npm";
      const res = deps.install(pm, `${CLI_PACKAGE}@${latest}`);
      if (!res.ok) {
        deps.log(`update: install failed${res.detail ? ` (${res.detail})` : ""}.`);
        return 1;
      }
      deps.log(`update: updated to v${latest}.`);
      return 0;
    }
  }
}

/** The real {@link UpdateDeps}: registry fetch, install-kind sniffing, a spawned installer. */
export function defaultUpdateDeps(): UpdateDeps {
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
