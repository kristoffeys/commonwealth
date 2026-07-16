import { spawn, spawnSync } from "node:child_process";
import { promises as fs, type Stats } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  defaultRegistryPath,
  resolveBrain,
  resolveBrainDir,
  resolveBrainMapping,
} from "@cmnwlth/core";
import { defaultHostIntegrationEnv, diagnoseHostIntegrations } from "./host-integration.js";

/**
 * `commonwealth doctor` — full-chain install/sync diagnosis (#134). The Commonwealth setup spans
 * several moving parts that each fail *silently*: the plugin install (#62), brain resolution for the
 * cwd, a dangling `.commonwealth/brain` marker shadowing the registry (#68), the sync health model,
 * and the remote-lag / review-queue / index-freshness / scope state. This walks the whole chain and
 * prints pass/fail with the exact one-line fix per failed link — the brew/flutter/expo-doctor triage
 * pattern.
 *
 * Sync health (ADR-0032): lifecycle sync (daemonless) is the healthy DEFAULT — the plugin hooks
 * commit/pull/push at session start & end, so a MISSING daemon is no longer a failure. A live daemon
 * is the opt-in daemon profile (also healthy); a stale daemon pidfile is a soft warning that
 * lifecycle sync still covers. The one thing that IS unhealthy is aged SYNC DEBT — unsynced work
 * (uncommitted note files / unpushed commits) that lifecycle sync should have flushed but hasn't
 * (offline, or a push that keeps failing) — surfaced as a warning with age.
 *
 * Read-only by default; the single self-heal (`--fix`) is capped strictly to restarting a stale
 * daemon (for daemon-profile users), so `doctor` can never mutate canon or wiring. Every check maps
 * to an already-readable surface — the daemon PID file, `git` ahead/behind, the staging queue, the
 * derived index mtime, the scope config — so this adds no new state.
 */

/** Outcome of a single diagnostic link. `skip` = couldn't determine (e.g. no `claude` on PATH). */
export type CheckStatus = "ok" | "warn" | "fail" | "skip";

/** One link in the chain: what it is, how it fared, and the exact fix when it didn't. */
export interface DoctorCheck {
  /** Stable machine id (for `--json` consumers / support scripts). */
  id: string;
  /** Human label. */
  label: string;
  status: CheckStatus;
  /** One-line human explanation of the current state. */
  detail: string;
  /** The exact one-line fix, present only when the link needs action. */
  fix?: string;
}

/** The whole diagnosis. `ok` is false iff any check `fail`ed. */
export interface DoctorReport {
  /** Directory the diagnosis ran against. */
  cwd: string;
  /** Resolved brain, or null when none maps to the cwd. */
  brain: string | null;
  checks: DoctorCheck[];
  /** True when no check has status `fail`. */
  ok: boolean;
  /** Whether a self-heal (daemon restart) was attempted this run. */
  healed?: boolean;
}

/** Git working-copy state relative to its last-fetched upstream (no network is performed). */
type GitState = { kind: "no-repo" } | { kind: "no-upstream" } | { kind: "tracked"; behind: number };

/** Result of executing `--version` through the installed plugin hook's live curate path. */
export interface CurateRuntimeProbe {
  kind: "entry" | "vendored" | "npx" | "unsupported" | "unknown";
  command: string;
  ok: boolean;
  code: number | null;
  version?: string;
  error?: string;
}

/** Render only the version token from child stdout; never pass arbitrary subprocess text through. */
function safeRuntimeVersion(value: string | undefined): string {
  return value?.match(/\b\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?\b/)?.[0] ?? "version OK";
}

/**
 * Ambient surfaces the diagnosis reads, all injectable so tests run against a fixture brain with
 * no `claude`/`git`/real home directory. {@link defaultDoctorEnv} wires the real ones.
 */
export interface DoctorEnv {
  cwd: string;
  /** Resolve the brain for a cwd. */
  resolveBrain: (cwd: string) => Promise<string | null>;
  /**
   * The three-way scope/resolution result for a cwd (ADR-0024 §3): `brain` (in scope), `denied` (an
   * explicit deny rule — out of scope), or `none` (nothing configured here). Distinct from
   * {@link resolveBrain}, which collapses `denied`/`none` to null and may be env-pinned; this reads
   * the ruleset so `doctor` can tell a deliberate deny apart from an unmapped dir.
   */
  resolveScope: (cwd: string) => Promise<"brain" | "denied" | "none">;
  /**
   * The git remote a missing brain could clone from (ADR-0019), or null. Optional — when absent,
   * a missing brain reads as a hard config error rather than a "not cloned yet" state.
   */
  resolveRemote?: (cwd: string) => Promise<string | null>;
  /**
   * Inspect the per-user config file for parseability (#210). Returns `null` when no config file
   * exists yet (a valid pre-`init` state — nothing to report); otherwise the resolved `path`, whether
   * it parses (`ok`), and the JSON parse `error` (with position, when V8 supplies it) when it does
   * not. This is the check that was ABSENT during the outage: a one-char hand-edit typo made every
   * reader treat the brain as missing and silently disabled capture, with `doctor` reporting nothing.
   */
  configParse: () => Promise<{ path: string; ok: boolean; error?: string } | null>;
  /** True if the `commonwealth` plugin is installed; null when it can't be determined. */
  pluginInstalled: () => boolean | null;
  /** Probe curate through the exact runtime resolution exported by the installed plugin (#222). */
  curateRuntime?: () => Promise<CurateRuntimeProbe | null>;
  /** Optional host-specific Claude/Codex diagnostics (#226); absent preserves the legacy report. */
  hostIntegrations?: () => Promise<DoctorCheck[]>;
  /** Whether `pid` is a live process (`kill -0`). */
  pidAlive: (pid: number) => boolean;
  /** Git state of the brain relative to its upstream. */
  gitState: (brainDir: string) => GitState;
  /** Restart the sync daemon for a brain (the only self-heal); resolves true on success. */
  startDaemon: (brainDir: string) => Promise<boolean>;
  /**
   * Sync debt for a brain (ADR-0032): unsynced local work — `uncommittedNotes` (note files not yet
   * committed) plus `unpushed` (commits ahead of the upstream) — and `oldestMs`, the epoch-ms of the
   * OLDEST piece of that debt (null when there is none), used to age the warning. Optional: when
   * absent (older API consumers), the debt link is simply not emitted.
   */
  syncDebt?: (
    brainDir: string,
  ) => Promise<{ uncommittedNotes: number; unpushed: number; oldestMs: number | null }>;
}

const COMMONWEALTH_DIR = ".commonwealth";
const PID_FILE = "sync.pid";
const MARKER_REL = path.join(".commonwealth", "brain");
/** Dirs never counted as note edits when checking index freshness (derived / local-only / vcs). */
const NON_NOTE_DIRS = new Set([".git", "index", COMMONWEALTH_DIR, "staging", "node_modules"]);
/** Sync debt older than this (24h) is unhealthy — lifecycle sync should have flushed it (ADR-0032). */
const DEBT_WARN_AGE_MS = 24 * 60 * 60 * 1000;

/** A coarse human age ("3h", "2d", "45m") for the sync-debt warning. */
function formatAge(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * True when a repo-relative path is a markdown NOTE file (not a derived/local-only artifact) — the
 * files whose uncommitted presence counts as sync debt. Mirrors the note-vs-derived split used
 * elsewhere: any `.md` outside the derived/vcs/local dirs, excluding the generated INDEX.md /
 * COMMONWEALTH.md.
 */
function isNoteRel(rel: string): boolean {
  if (!rel.endsWith(".md")) return false;
  const base = rel.split("/").pop() ?? "";
  if (base === "INDEX.md" || base === "COMMONWEALTH.md") return false;
  const top = rel.split("/")[0] ?? "";
  return !NON_NOTE_DIRS.has(top);
}

/** Read the daemon PID recorded for a brain, or null when there is no PID file. */
async function readPid(brainDir: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(path.join(brainDir, COMMONWEALTH_DIR, PID_FILE), "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Read a `.commonwealth/brain` marker from `dir` (its trimmed target), or null when absent/blank. */
async function readMarkerTarget(dir: string): Promise<string | null> {
  try {
    const raw = (await fs.readFile(path.join(dir, MARKER_REL), "utf8")).trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** True when `dir` exists and is a directory. */
async function isDir(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** Newest mtime (ms) across the brain's note files, ignoring derived / local-only / vcs dirs. */
async function newestNoteMtime(brainDir: string): Promise<number | null> {
  let newest: number | null = null;
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (NON_NOTE_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        let stat: Stats;
        try {
          stat = await fs.stat(path.join(dir, entry.name));
        } catch {
          continue;
        }
        if (newest === null || stat.mtimeMs > newest) newest = stat.mtimeMs;
      }
    }
  }
  await walk(brainDir);
  return newest;
}

/** Count the notes currently staged for review under `staging/` (best-effort; 0 on any error). */
async function countStaged(brainDir: string): Promise<number> {
  const root = path.join(brainDir, "staging");
  let count = 0;
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) await walk(path.join(dir, entry.name));
      else if (entry.isFile() && entry.name.endsWith(".md")) count += 1;
    }
  }
  await walk(root);
  return count;
}

/** The real ambient surfaces: registry resolution, `claude`/`git` probes, PID liveness, daemon start. */
export function defaultDoctorEnv(cwd: string): DoctorEnv {
  const brainEnv = process.env.COMMONWEALTH_BRAIN_DIR;
  type PluginListEntry = { id?: string; enabled?: boolean; installPath?: string };
  let pluginList: PluginListEntry[] | null | undefined;
  const installedPlugin = (): PluginListEntry | null | undefined => {
    if (pluginList === undefined) {
      const probe = spawnSync("claude", ["plugin", "list", "--json"], { encoding: "utf8" });
      if (probe.error || probe.status !== 0) {
        pluginList = null;
      } else {
        try {
          const parsed: unknown = JSON.parse(probe.stdout);
          pluginList = Array.isArray(parsed) ? (parsed as PluginListEntry[]) : null;
        } catch {
          pluginList = null;
        }
      }
    }
    if (pluginList === null) return null; // CLI unavailable / output unknown
    return pluginList.find((p) => p.id === "commonwealth@commonwealth" && p.enabled !== false);
  };
  return {
    cwd,
    // The per-user config file readers actually resolve (COMMONWEALTH_REGISTRY → COMMONWEALTH_CONFIG
    // → ~/.commonwealth/config.json). Missing → null (fine); present-but-unparseable → the loud fail.
    configParse: async () => {
      const p = defaultRegistryPath();
      let raw: string;
      try {
        raw = await fs.readFile(p, "utf8");
      } catch {
        return null; // no file yet — a valid pre-init state, nothing to report
      }
      try {
        JSON.parse(raw);
        return { path: p, ok: true };
      } catch (err) {
        return { path: p, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    // `$COMMONWEALTH_BRAIN_DIR` pins the brain (resolution layer 4); otherwise walk the registry.
    resolveBrain: (dir) =>
      brainEnv && brainEnv.length > 0
        ? Promise.resolve(path.resolve(brainEnv))
        : resolveBrainDir(dir),
    // Scope reads the ruleset directly (never env-pinned): the single ADR-0024 §3 pass that folds
    // in the legacy allow/deny. `scopeConfigPath` (→ `$COMMONWEALTH_CONFIG`) selects the file.
    resolveScope: async (dir) => {
      // A corrupt config surfaces via the dedicated config-parse check (#210); for scope it just
      // degrades to "none" (undeterminable) rather than widening this three-way result.
      const kind = (await resolveBrain(dir, { registryPath: process.env.COMMONWEALTH_CONFIG }))
        .kind;
      return kind === "corrupt-config" ? "none" : kind;
    },
    resolveRemote: async (dir) => {
      if (brainEnv && brainEnv.length > 0) return null; // env-pinned brains carry no mapping remote
      return (await resolveBrainMapping(dir))?.remote ?? null;
    },
    pluginInstalled: () => {
      // JSON includes installPath, which the runtime probe below needs. Null means the Claude CLI
      // is absent/too old to expose the install surface; undefined means it is healthy but the
      // Commonwealth plugin is not installed.
      const plugin = installedPlugin();
      return plugin === null ? null : plugin !== undefined;
    },
    curateRuntime: async () => {
      const plugin = installedPlugin();
      if (!plugin || typeof plugin.installPath !== "string") return null;
      const hookLib = path.join(plugin.installPath, "hooks", "lib.mjs");
      try {
        // Import the installed hook's exported probe. This deliberately shares resolution code
        // with capture itself: vendor presence, npx pin, and future strategies cannot drift.
        const mod = (await import(pathToFileURL(hookLib).href)) as {
          probeCurateRuntime?: () => Promise<CurateRuntimeProbe>;
        };
        if (typeof mod.probeCurateRuntime !== "function") {
          return {
            kind: "unsupported",
            command: hookLib,
            ok: false,
            code: null,
            error: "installed plugin predates curate runtime diagnostics; update it",
          };
        }
        return await mod.probeCurateRuntime();
      } catch (err) {
        return {
          kind: "unknown",
          command: hookLib,
          ok: false,
          code: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    hostIntegrations: () => diagnoseHostIntegrations(defaultHostIntegrationEnv(cwd)),
    pidAlive: (pid) => {
      try {
        process.kill(pid, 0); // signal 0 = existence check
        return true;
      } catch {
        return false;
      }
    },
    gitState: (brainDir) => {
      const git = (args: string[]): { code: number; out: string } => {
        const r = spawnSync("git", ["-C", brainDir, ...args], { encoding: "utf8" });
        return { code: r.status ?? 1, out: (r.stdout ?? "").trim() };
      };
      if (git(["rev-parse", "--git-dir"]).code !== 0) return { kind: "no-repo" };
      if (git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).code !== 0)
        return { kind: "no-upstream" };
      const behind = git(["rev-list", "--count", "HEAD..@{u}"]);
      const n = Number.parseInt(behind.out, 10);
      return { kind: "tracked", behind: Number.isFinite(n) ? n : 0 };
    },
    syncDebt: async (brainDir) => {
      const git = (args: string[]): { code: number; out: string } => {
        const r = spawnSync("git", ["-C", brainDir, ...args], { encoding: "utf8" });
        return { code: r.status ?? 1, out: (r.stdout ?? "").trim() };
      };
      if (git(["rev-parse", "--git-dir"]).code !== 0) {
        return { uncommittedNotes: 0, unpushed: 0, oldestMs: null };
      }
      let oldestMs: number | null = null;
      const seeOld = (ms: number): void => {
        if (Number.isFinite(ms) && (oldestMs === null || ms < oldestMs)) oldestMs = ms;
      };

      // Uncommitted note files: porcelain paths whose leaf is a note .md (not derived/local). Age by
      // working-tree mtime (best-effort — a file we can't stat just doesn't contribute an age).
      let uncommittedNotes = 0;
      for (const line of git(["status", "--porcelain", "--untracked-files=all"]).out.split("\n")) {
        if (!line.trim()) continue;
        let file = line.slice(3).trim();
        const arrow = file.indexOf(" -> ");
        if (arrow !== -1) file = file.slice(arrow + 4);
        file = file.replace(/^"(.*)"$/, "$1");
        if (!isNoteRel(file)) continue;
        uncommittedNotes += 1;
        try {
          seeOld((await fs.stat(path.join(brainDir, file))).mtimeMs);
        } catch {
          // unreadable/deleted — count it but contribute no age
        }
      }

      // Unpushed commits: ahead of the tracked upstream. The OLDEST unpushed commit's committer date
      // ages the debt (a week-old unpushed commit is the incident signal). No upstream → can't tell.
      let unpushed = 0;
      if (git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).code === 0) {
        const ahead = Number.parseInt(git(["rev-list", "--count", "@{u}..HEAD"]).out, 10);
        unpushed = Number.isFinite(ahead) ? ahead : 0;
        if (unpushed > 0) {
          const ts = git(["log", "@{u}..HEAD", "--format=%ct", "--reverse"])
            .out.split("\n")[0]
            ?.trim();
          const secs = Number.parseInt(ts ?? "", 10);
          if (Number.isFinite(secs)) seeOld(secs * 1000);
        }
      }
      return { uncommittedNotes, unpushed, oldestMs };
    },
    startDaemon: (brainDir) =>
      new Promise<boolean>((resolve) => {
        try {
          // Restart via the workspace `commonwealth-sync` bin, detached so it outlives doctor.
          const require = createRequire(import.meta.url);
          const pkgJson = require("@cmnwlth/sync/package.json") as { bin: Record<string, string> };
          const bin = path.join(
            path.dirname(require.resolve("@cmnwlth/sync/package.json")),
            Object.values(pkgJson.bin)[0]!,
          );
          const child = spawn("node", [bin, "start", "--dir", brainDir], {
            detached: true,
            stdio: "ignore",
          });
          child.on("error", () => resolve(false));
          child.unref();
          resolve(true);
        } catch {
          resolve(false);
        }
      }),
  };
}

/**
 * Walk the full install/sync chain and return a structured {@link DoctorReport}. Pure w.r.t. its
 * {@link DoctorEnv} — the only side effect is the optional daemon restart when `opts.fix` is set
 * and the daemon link failed.
 */
export async function diagnose(
  env: DoctorEnv,
  opts: { fix?: boolean } = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const cwd = path.resolve(env.cwd);

  // 1) Plugin — inferred from the install surface, never asserted.
  const plugin = env.pluginInstalled();
  checks.push(
    plugin === null
      ? {
          id: "plugin",
          label: "Plugin",
          status: "skip",
          detail: "Can't verify — no `claude` CLI on PATH.",
        }
      : plugin
        ? {
            id: "plugin",
            label: "Plugin",
            status: "ok",
            detail: "commonwealth plugin is installed.",
          }
        : {
            id: "plugin",
            label: "Plugin",
            status: "warn",
            detail: "commonwealth plugin is not installed for this user.",
            fix: "claude plugin marketplace add kristoffeys/commonwealth && claude plugin install commonwealth@commonwealth",
          },
  );

  // 2) Curate runtime (#222): execute `--version` through the installed hook's own resolver. The
  //    current portable marketplace install uses npx (warn, because registry/cache are live deps);
  //    a non-zero exit is a hard failure because capture would otherwise lose every candidate.
  if (env.curateRuntime) {
    const runtime = await env.curateRuntime();
    if (runtime === null) {
      checks.push({
        id: "curate-runtime",
        label: "Curate runtime",
        status: "skip",
        detail: "Can't locate the installed plugin runtime path.",
      });
    } else if (runtime.kind === "unsupported") {
      checks.push({
        id: "curate-runtime",
        label: "Curate runtime",
        status: "warn",
        detail:
          "The installed plugin cannot expose its live curate path. Child diagnostics were redacted. Capture status was not inferred.",
        fix: "commonwealth update   (install the current plugin diagnostics)",
      });
    } else if (!runtime.ok) {
      const exit =
        typeof runtime.code === "number" ? `exit ${runtime.code}` : "spawn/import failure";
      checks.push({
        id: "curate-runtime",
        label: "Curate runtime",
        status: "fail",
        detail: `Live path ${runtime.command} failed (${exit}); child diagnostics were redacted. Capture is OFF.`,
        fix:
          runtime.kind === "npx"
            ? `clear the broken npm npx cache, then run: ${runtime.command} --version`
            : "commonwealth update   (reinstall the plugin runtime)",
      });
    } else if (runtime.kind === "npx") {
      checks.push({
        id: "curate-runtime",
        label: "Curate runtime",
        status: "warn",
        detail: `Live path is ${runtime.command} (${safeRuntimeVersion(runtime.version)}); capture depends on the npm registry/cache fallback.`,
      });
    } else {
      checks.push({
        id: "curate-runtime",
        label: "Curate runtime",
        status: "ok",
        detail: `Live ${runtime.kind} path is healthy: ${runtime.command} (${safeRuntimeVersion(runtime.version)}).`,
      });
    }
  }

  // Host parity diagnostics (#226) are additive and optional. Existing API consumers that build
  // a DoctorEnv keep the legacy report unchanged; the real environment inspects Claude and Codex
  // independently, including plugin/MCP/hooks/extractor health and Codex's emitted fallback.
  if (env.hostIntegrations) checks.push(...(await env.hostIntegrations()));

  // 3) Config parse (#210): a present-but-unparseable per-user config makes EVERY reader treat the
  //    brain as missing — capture silently OFF for days with zero signal. This is exactly the class
  //    of failure `doctor` reported nothing about during the outage. It does NOT short-circuit: an
  //    env-pinned brain can still resolve past a broken config, and the chain below stays useful.
  const config = await env.configParse();
  if (config && !config.ok) {
    checks.push({
      id: "config",
      label: "Config",
      status: "fail",
      detail: `Config file ${config.path} is unparseable: ${config.error}. Every reader treats the brain as missing, so capture is OFF.`,
      fix: `fix the JSON (a stray trailing comma is the usual cause), or restore ${config.path} from a .corrupt-<ts> backup`,
    });
  } else if (config) {
    checks.push({
      id: "config",
      label: "Config",
      status: "ok",
      detail: `Config file ${config.path} parses.`,
    });
  }
  // config === null → no file yet (valid pre-init state); say nothing.

  // 4) Brain resolution for the cwd. A miss short-circuits every brain-scoped link below.
  const brain = await env.resolveBrain(cwd);
  if (!brain) {
    checks.push({
      id: "brain",
      label: "Brain",
      status: "fail",
      detail: `No brain resolves for ${cwd}.`,
      fix: "commonwealth init   (or add a prefix → brain mapping to ~/.commonwealth/registry.json)",
    });
    return finalize(cwd, null, checks, false);
  }
  const brainExists = await isDir(brain);
  if (brainExists) {
    checks.push({ id: "brain", label: "Brain", status: "ok", detail: `Resolves to ${brain}.` });
  } else {
    // Missing dir: distinguish "mapped but not cloned yet" (recoverable via clone-on-demand,
    // ADR-0019) from a truly dangling path. Both fail — the brain is unusable until materialized.
    const remote = env.resolveRemote ? await env.resolveRemote(cwd) : null;
    checks.push({
      id: "brain",
      label: "Brain",
      status: "fail",
      detail: remote
        ? `Mapped to ${brain} but not cloned yet (remote: ${remote}).`
        : `Resolves to ${brain}, but that directory is missing.`,
      fix: remote
        ? "commonwealth sync once   (clones the brain on demand)"
        : "commonwealth init   (recreate/join the brain)",
    });
  }

  // 3) Marker sanity (#68): a `.commonwealth/brain` marker pointing at a missing dir is silently
  //    ignored by resolution and shadows nothing — but it's a latent trap, so surface it.
  const markerCheck = await checkMarker(cwd);
  if (markerCheck) checks.push(markerCheck);

  // 4) Sync health (ADR-0032). Lifecycle sync (daemonless) is the healthy DEFAULT: the plugin hooks
  //    commit/pull/push at session start & end, so NO daemon is OK. A live daemon is the opt-in
  //    daemon profile (also OK). A stale pidfile (a daemon profile that died) is a soft WARN, never a
  //    failure — lifecycle sync still converges the brain; `--fix` restarts it for daemon-profile
  //    users who want it back. Aged debt (the next check) is the real unhealthy signal, not "no daemon".
  const pid = await readPid(brain);
  const alive = pid !== null && env.pidAlive(pid);
  let healed = false;
  if (alive) {
    checks.push({
      id: "daemon",
      label: "Sync",
      status: "ok",
      detail: `Daemon profile — sync daemon running (pid ${pid}).`,
    });
  } else if (pid !== null && opts.fix) {
    // A stale pidfile means the daemon profile was in use and died; --fix restarts it.
    healed = await env.startDaemon(brain);
    checks.push({
      id: "daemon",
      label: "Sync",
      status: healed ? "ok" : "warn",
      detail: healed
        ? `Daemon profile — restarted the stale sync daemon (was pid ${pid}).`
        : `Lifecycle sync (daemonless) — the recorded daemon (pid ${pid}) is dead and the restart failed; hooks still sync each session.`,
      ...(healed ? {} : { fix: "commonwealth sync start   (retry the daemon profile)" }),
    });
  } else if (pid !== null) {
    checks.push({
      id: "daemon",
      label: "Sync",
      status: "warn",
      detail: `Lifecycle sync (daemonless). A stale daemon pidfile remains (recorded pid ${pid} is dead).`,
      fix: `rm ${path.join(brain, COMMONWEALTH_DIR, PID_FILE)}   (or: commonwealth sync start to run the daemon profile)`,
    });
  } else {
    checks.push({
      id: "daemon",
      label: "Sync",
      status: "ok",
      detail: "Lifecycle sync (daemonless) — hooks sync at session start & end.",
    });
  }

  // 4b) Sync debt (ADR-0032): unsynced work — uncommitted note files or unpushed commits. Fresh debt
  //     is normal (a session just ended, next SessionStart flushes it). Debt OLDER than the threshold
  //     means lifecycle sync isn't flushing (offline, or a push that keeps failing) → warn with age.
  if (env.syncDebt) {
    const debt = await env.syncDebt(brain);
    const pending = debt.uncommittedNotes + debt.unpushed;
    if (pending === 0) {
      checks.push({
        id: "debt",
        label: "Sync debt",
        status: "ok",
        detail: "No unsynced changes — everything is committed and pushed.",
      });
    } else {
      const ageMs = debt.oldestMs !== null ? Math.max(0, Date.now() - debt.oldestMs) : 0;
      const what = [
        debt.uncommittedNotes > 0 ? `${debt.uncommittedNotes} uncommitted note(s)` : null,
        debt.unpushed > 0 ? `${debt.unpushed} unpushed commit(s)` : null,
      ]
        .filter(Boolean)
        .join(", ");
      if (ageMs >= DEBT_WARN_AGE_MS) {
        checks.push({
          id: "debt",
          label: "Sync debt",
          status: "warn",
          detail: `${what} — oldest is ${formatAge(ageMs)} old; lifecycle sync hasn't flushed it.`,
          fix: "commonwealth sync once",
        });
      } else {
        checks.push({
          id: "debt",
          label: "Sync debt",
          status: "ok",
          detail: `${what} pending — will flush at the next session.`,
        });
      }
    }
  }

  // 5) Remote lag — behind the last-fetched upstream (no network; the daemon does the fetching).
  const git = env.gitState(brain);
  if (git.kind === "no-repo") {
    checks.push({
      id: "remote",
      label: "Remote",
      status: "warn",
      detail: "Brain is not a git repo — nothing syncs.",
      fix: "git -C <brain> init && git -C <brain> remote add origin <url>",
    });
  } else if (git.kind === "no-upstream") {
    checks.push({
      id: "remote",
      label: "Remote",
      status: "warn",
      detail: "No upstream configured — your changes stay local.",
      fix: "commonwealth init --remote <url>",
    });
  } else if (git.behind > 0) {
    checks.push({
      id: "remote",
      label: "Remote",
      status: "warn",
      detail: `${git.behind} commit(s) behind origin — a sync is due.`,
      fix: "commonwealth sync once",
    });
  } else {
    checks.push({
      id: "remote",
      label: "Remote",
      status: "ok",
      detail: "Up to date with the last-fetched origin.",
    });
  }

  // 6) Review queue depth — informational (high depth is expected when autoPromote is off).
  const staged = await countStaged(brain);
  checks.push({
    id: "queue",
    label: "Queue",
    status: "ok",
    detail:
      staged === 0
        ? "No notes awaiting review."
        : `${staged} note(s) awaiting review${staged >= 25 ? " — consider `commonwealth promote --all`." : "."}`,
  });

  // 7) Index freshness — the derived FTS index is disposable and rebuilds on demand, so a stale
  //    or missing index is a warn, never a failure.
  checks.push(await checkIndex(brain));

  // 8) Scope — is the cwd in capture scope (ADR-0024 §3)? The single resolution pass answers it:
  //    `brain` = in scope; `denied` = an explicit deny rule (out of scope); `none` = nothing
  //    configured here. Out-of-scope is often intended (a personal project), so it warns, never fails.
  const scope = await env.resolveScope(cwd);
  checks.push(
    scope === "brain"
      ? { id: "scope", label: "Scope", status: "ok", detail: "cwd is in capture scope." }
      : scope === "denied"
        ? {
            id: "scope",
            label: "Scope",
            status: "warn",
            detail: "cwd is OUT of capture scope — a deny rule matches it (may be intended).",
            fix: "commonwealth registry show   # find and `commonwealth registry remove` the deny",
          }
        : {
            id: "scope",
            label: "Scope",
            status: "warn",
            detail: "cwd is OUT of capture scope — no rule maps it (may be intended).",
            fix: `commonwealth add ${cwd}`,
          },
  );

  const report = finalize(cwd, brain, checks, false);
  report.healed = healed || undefined;
  return report;
}

/** Detect a dangling `.commonwealth/brain` marker at/above the cwd (#68). Null when none is notable. */
async function checkMarker(cwd: string): Promise<DoctorCheck | null> {
  let dir = cwd;
  for (;;) {
    const target = await readMarkerTarget(dir);
    if (target !== null) {
      const resolved = path.isAbsolute(target) ? target : path.resolve(dir, target);
      if (await isDir(resolved)) {
        return {
          id: "marker",
          label: "Marker",
          status: "ok",
          detail: `Brain marker → ${resolved}.`,
        };
      }
      return {
        id: "marker",
        label: "Marker",
        status: "warn",
        detail: `Dangling brain marker in ${dir} → ${target} (missing); it is ignored, so resolution falls through to the registry.`,
        fix: `rm ${path.join(dir, MARKER_REL)}`,
      };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Index-freshness link: missing → warn, older than the newest note → warn (stale), else ok. */
async function checkIndex(brainDir: string): Promise<DoctorCheck> {
  const dbFile = path.join(brainDir, "index", "commonwealth.db");
  let dbStat: Stats | null = null;
  try {
    dbStat = await fs.stat(dbFile);
  } catch {
    dbStat = null;
  }
  if (!dbStat) {
    return {
      id: "index",
      label: "Index",
      status: "warn",
      detail: "Search index not built yet — it builds on the next search/sync.",
      fix: "commonwealth recall <query>   (triggers a rebuild)",
    };
  }
  const newest = await newestNoteMtime(brainDir);
  if (newest !== null && newest > dbStat.mtimeMs) {
    return {
      id: "index",
      label: "Index",
      status: "warn",
      detail: "Search index is older than the newest note — it rebuilds on the next search.",
      fix: "commonwealth recall <query>   (triggers a rebuild)",
    };
  }
  return { id: "index", label: "Index", status: "ok", detail: "Search index is current." };
}

/** Assemble the report and compute `ok` (false iff any check failed). */
function finalize(
  cwd: string,
  brain: string | null,
  checks: DoctorCheck[],
  healed: boolean,
): DoctorReport {
  return {
    cwd,
    brain,
    checks,
    ok: !checks.some((c) => c.status === "fail"),
    healed: healed || undefined,
  };
}

const SYMBOLS: Record<CheckStatus, string> = { ok: "✓", warn: "⚠", fail: "✗", skip: "–" };

/** Render a {@link DoctorReport} as the human pass/fail chain with per-failure fixes. */
export function formatDoctorText(report: DoctorReport): string {
  const lines: string[] = [`commonwealth doctor — ${report.cwd}`, ""];
  for (const c of report.checks) {
    lines.push(`  ${SYMBOLS[c.status]} ${c.label.padEnd(7)} ${c.detail}`);
    if (c.fix) lines.push(`      fix: ${c.fix}`);
  }
  lines.push("");
  const failed = report.checks.filter((c) => c.status === "fail").length;
  const warned = report.checks.filter((c) => c.status === "warn").length;
  lines.push(
    report.ok
      ? warned > 0
        ? `All critical links pass (${warned} warning${warned === 1 ? "" : "s"}).`
        : "All checks pass."
      : `${failed} check${failed === 1 ? "" : "s"} failed — apply the fix(es) above.`,
  );
  return `${lines.join("\n")}\n`;
}
