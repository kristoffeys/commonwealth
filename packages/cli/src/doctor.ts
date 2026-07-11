import { spawn, spawnSync } from "node:child_process";
import { promises as fs, type Stats } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  defaultRegistryPath,
  resolveBrain,
  resolveBrainDir,
  resolveBrainMapping,
} from "@cmnwlth/core";

/**
 * `commonwealth doctor` — full-chain install/sync diagnosis (#134). The Commonwealth setup spans
 * five moving parts that each fail *silently*: the plugin install (#62), brain resolution for the
 * cwd, a dangling `.commonwealth/brain` marker shadowing the registry (#68), a dead sync daemon
 * (→ a stale brain that reads as "the product lies"), and the remote-lag / review-queue /
 * index-freshness / scope state. This walks the whole chain and prints pass/fail with the exact
 * one-line fix per failed link — the brew/flutter/expo-doctor triage pattern.
 *
 * Read-only by default; the single self-heal (`--fix`) is capped strictly to restarting a dead
 * daemon, so `doctor` can never mutate canon or wiring. Every check maps to an already-readable
 * surface — the daemon PID file, `git` behind-count, the staging queue, the derived index mtime,
 * the scope config — so this adds no new state.
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
  /** Whether `pid` is a live process (`kill -0`). */
  pidAlive: (pid: number) => boolean;
  /** Git state of the brain relative to its upstream. */
  gitState: (brainDir: string) => GitState;
  /** Restart the sync daemon for a brain (the only self-heal); resolves true on success. */
  startDaemon: (brainDir: string) => Promise<boolean>;
}

const COMMONWEALTH_DIR = ".commonwealth";
const PID_FILE = "sync.pid";
const MARKER_REL = path.join(".commonwealth", "brain");
/** Dirs never counted as note edits when checking index freshness (derived / local-only / vcs). */
const NON_NOTE_DIRS = new Set([".git", "index", COMMONWEALTH_DIR, "staging", "node_modules"]);

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
      // Inferred from `claude plugin list` (the same surface `init` installs into). Null when
      // there is no `claude` on PATH — we present plugin state as inferred, never assert it.
      const probe = spawnSync("claude", ["plugin", "list"], { encoding: "utf8" });
      if (probe.error || probe.status !== 0) return null;
      return `${probe.stdout}\n${probe.stderr}`.toLowerCase().includes("commonwealth");
    },
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

  // 2) Config parse (#210): a present-but-unparseable per-user config makes EVERY reader treat the
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

  // 3) Brain resolution for the cwd. A miss short-circuits every brain-scoped link below.
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

  // 4) Daemon liveness — a dead daemon means a stale brain. The sole self-heal target.
  const pid = await readPid(brain);
  const alive = pid !== null && env.pidAlive(pid);
  let healed = false;
  if (alive) {
    checks.push({
      id: "daemon",
      label: "Daemon",
      status: "ok",
      detail: `Sync daemon running (pid ${pid}).`,
    });
  } else if (opts.fix) {
    healed = await env.startDaemon(brain);
    checks.push({
      id: "daemon",
      label: "Daemon",
      status: healed ? "ok" : "fail",
      detail: healed
        ? "Sync daemon was not running — restarted it."
        : "Sync daemon is not running and the restart failed.",
      ...(healed ? {} : { fix: "commonwealth sync start" }),
    });
  } else {
    checks.push({
      id: "daemon",
      label: "Daemon",
      status: "fail",
      detail:
        pid === null
          ? "No sync daemon running — your brain won't converge with teammates."
          : `Recorded daemon (pid ${pid}) is not alive — stale PID file.`,
      fix: "commonwealth doctor --fix   (or: commonwealth sync start)",
    });
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
