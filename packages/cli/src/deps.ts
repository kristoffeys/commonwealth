import { spawn, spawnSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "@commonwealth/core";
import type { NewNoteInput } from "@commonwealth/core";
import { gatherCandidates } from "@commonwealth/seed";
import { findRepoRoot, runInit, type InitDeps } from "./init.js";
import type { OnboardDeps } from "./onboard.js";

/** Options for {@link defaultInitDeps}, mostly to make wiring testable/overridable. */
export interface DefaultInitDepsOptions {
  /** Absolute path to `commonwealth-curate`'s built entry (its `capture` subcommand is spawned). */
  curateEntry?: string;
  /** When true, `confirm` always resolves `true` (from `--yes`). */
  assumeYes?: boolean;
}

/**
 * Resolve the `commonwealth-curate` CLI entry point: explicit override → `COMMONWEALTH_CURATE_BIN`
 * env → the `@commonwealth/curate` package's declared `bin`. Throws only if none resolve, and
 * that throw is caught by {@link makeStage} (staging degrades to a no-op with a log line).
 */
function resolveCurateEntry(override?: string): string {
  if (override) return override;
  const fromEnv = process.env.COMMONWEALTH_CURATE_BIN;
  if (fromEnv) return fromEnv;

  const require = createRequire(import.meta.url);
  const pkgJsonPath = require.resolve("@commonwealth/curate/package.json");
  const pkg = require("@commonwealth/curate/package.json") as {
    bin?: string | Record<string, string>;
  };
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["commonwealth-curate"];
  if (!rel) throw new Error("@commonwealth/curate exposes no `commonwealth-curate` bin");
  return path.resolve(path.dirname(pkgJsonPath), rel);
}

/**
 * Build a `stage` that pipes candidates as JSON into `node <curateEntry> capture --dir
 * <brain>` and counts the staged notes from stdout (curate prints one line per staged
 * note). Never throws: on spawn failure or non-zero exit it logs to stderr and returns
 * `{ captured: 0 }`, so a broken curate can't abort the wizard.
 */
function makeStage(
  curateEntry: string,
  log: (m: string) => void,
): (brainDir: string, candidates: NewNoteInput[]) => Promise<{ captured: number }> {
  return (brainDir, candidates) =>
    new Promise((resolve) => {
      const child = spawn("node", [curateEntry, "capture", "--dir", brainDir, "--force"], {
        stdio: ["pipe", "pipe", "inherit"],
      });

      let out = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        out += chunk;
      });

      child.on("error", (err) => {
        log(`Staging failed to spawn commonwealth-curate: ${err.message}`);
        resolve({ captured: 0 });
      });

      child.on("close", (code) => {
        if (code !== 0) {
          log(`commonwealth-curate exited with code ${code ?? "null"}; staged nothing.`);
          resolve({ captured: 0 });
          return;
        }
        const captured = out.split("\n").filter((line) => line.trim().length > 0).length;
        resolve({ captured });
      });

      // Guard the stdin stream: if the child dies before consuming input, the write emits an
      // EPIPE 'error' that would otherwise be unhandled and crash `init` (#104). The 'error'/
      // 'close' handlers above still resolve the promise.
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(candidates));
    });
}

/** Prompt on stdin for a yes/no answer; anything starting with `y` (case-insensitive) is yes. */
function promptConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/**
 * Wire the real {@link InitDeps}: seed for gathering, core for brain/marker resolution, a
 * spawned `commonwealth-curate capture` for staging, a readline prompt for confirmation, and
 * stderr for logging. Pure orchestration lives in {@link runInit}; this is the only place
 * that performs real I/O.
 *
 * @param opts Optional overrides ({@link DefaultInitDepsOptions}).
 * @returns A fully-wired {@link InitDeps}.
 */
export function defaultInitDeps(opts: DefaultInitDepsOptions = {}): InitDeps {
  const log = (m: string): void => {
    process.stderr.write(m + "\n");
  };

  let curateEntry: string | null = null;
  let curateError: string | null = null;
  try {
    curateEntry = resolveCurateEntry(opts.curateEntry);
  } catch (err) {
    curateError = (err as Error).message;
  }

  const stage = curateEntry
    ? makeStage(curateEntry, log)
    : async (): Promise<{ captured: number }> => {
        log(`Cannot stage: ${curateError ?? "commonwealth-curate not found"}.`);
        return { captured: 0 };
      };

  return {
    gather: (repoDir) => gatherCandidates(repoDir),
    resolveBrain: (cwd) => core.resolveBrainDir(cwd),
    createBrain: (dir, name) => core.initBrain(dir, { name }),
    registerBrain: async (repoDir, brainDir) => {
      // ADR-0011: the global registry is the source of truth; no per-project marker.
      await core.addRegistryMapping(repoDir, brainDir);
      await core.linkBrain(path.basename(brainDir), brainDir);
    },
    stage,
    confirm: opts.assumeYes ? async () => true : promptConfirm,
    log,
  };
}

/** Options for {@link defaultOnboardDeps}, mostly to make wiring testable/overridable. */
export interface DefaultOnboardDepsOptions {
  /** Repo root to resolve dist paths from; defaults to the nearest `.git` ancestor of cwd. */
  repoRoot?: string;
  /** Absolute path to `commonwealth-curate`'s built entry, forwarded to {@link defaultInitDeps}. */
  curateEntry?: string;
}

/** The workspace packages whose `dist/index.js` must exist for the plugin to run standalone. */
const REQUIRED_DIST_PACKAGES = ["core", "mcp", "sync", "curate", "seed", "cli"] as const;

/** True if the `<name>` executable resolves on the current PATH. */
function hasExecutable(name: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  const res = spawnSync(probe, [name], { stdio: "ignore" });
  return res.status === 0;
}

/**
 * True if `claude <args>` (a list/plural command) reports an entry named `name`. Prefers the
 * structured `--json` output (exact `id`/`name`/`plugin` match) so an unrelated entry whose text
 * merely contains `name` cannot be mistaken for ours; falls back to a whole-word text scan when
 * `--json` is unavailable. Never throws — an unresolvable claude means "not present".
 */
function hasClaudeEntry(args: string[], name: string): boolean {
  const json = spawnSync("claude", [...args, "--json"], { encoding: "utf8" });
  if (json.status === 0 && json.stdout) {
    try {
      const parsed: unknown = JSON.parse(json.stdout);
      const rows = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { plugins?: unknown }).plugins)
          ? (parsed as { plugins: unknown[] }).plugins
          : [];
      return rows.some((row) => {
        if (typeof row !== "object" || row === null) return false;
        const r = row as { id?: unknown; name?: unknown; plugin?: unknown };
        return (
          r.id === name ||
          r.name === name ||
          r.plugin === name ||
          (typeof r.id === "string" && r.id.split("@")[0] === name)
        );
      });
    } catch {
      // fall through to the text scan
    }
  }
  const text = spawnSync("claude", args, { encoding: "utf8" });
  const out = `${text.stdout ?? ""}${text.stderr ?? ""}`;
  return text.status === 0 && new RegExp(`(^|\\s)${name}(\\s|@|$)`, "m").test(out);
}

/**
 * Wire the real {@link OnboardDeps}: a dist-presence check that triggers `pnpm -r build` + the
 * plugin bundle, `runInit` for the brain core, an idempotent plugin install via the repo
 * marketplace (`claude plugin marketplace add` + `claude plugin install`), and a detached
 * sync daemon. Every step degrades to a `skipped` note rather than throwing, so a missing
 * `pnpm`/`claude` never aborts onboarding. Pure orchestration lives in {@link runOnboard}.
 *
 * @param opts Optional overrides ({@link DefaultOnboardDepsOptions}).
 * @returns A fully-wired {@link OnboardDeps}.
 */
/**
 * The Commonwealth install root (the monorepo checkout), found by walking up from THIS
 * module for `pnpm-workspace.yaml`. This is where the built per-package dist binaries
 * live — resolved from the CLI's own location, NOT the user's cwd, so `init` works when
 * run inside an arbitrary project. Returns null when not running from a workspace checkout
 * (e.g. a future npm-global install), in which case build/spawn steps degrade gracefully.
 */
function commonwealthRoot(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function defaultOnboardDeps(opts: DefaultOnboardDepsOptions = {}): OnboardDeps {
  const log = (m: string): void => {
    process.stderr.write(m + "\n");
  };

  // Resolve tool binaries from the Commonwealth install, not the target project's cwd.
  const repoRoot = opts.repoRoot ?? commonwealthRoot() ?? findRepoRoot(process.cwd());
  const isWorkspace = existsSync(path.join(repoRoot, "pnpm-workspace.yaml"));
  const distEntry = (pkg: string): string =>
    path.join(repoRoot, "packages", pkg, "dist", "index.js");

  const ensureBuilt = async (): Promise<{ built: boolean; skipped?: string }> => {
    if (!isWorkspace) {
      return { built: false, skipped: "not a workspace checkout; assuming an installed build" };
    }
    const missing = REQUIRED_DIST_PACKAGES.filter((pkg) => !existsSync(distEntry(pkg)));
    if (missing.length === 0) return { built: false };
    if (!hasExecutable("pnpm")) {
      return {
        built: false,
        skipped: `pnpm not found; cannot build (missing: ${missing.join(", ")})`,
      };
    }
    const build = spawnSync("pnpm", ["-r", "build"], { cwd: repoRoot, stdio: "inherit" });
    if (build.status !== 0) {
      const reason = build.error
        ? build.error.message
        : build.signal
          ? `signal ${build.signal}`
          : `exit code ${build.status}`;
      return { built: false, skipped: `pnpm -r build failed (${reason})` };
    }
    // Best-effort: refresh the vendored plugin bundle; failure here is non-fatal.
    const bundle = path.join(repoRoot, "packages", "plugin", "scripts", "bundle.mjs");
    if (existsSync(bundle)) {
      const res = spawnSync("node", [bundle], { cwd: repoRoot, stdio: "inherit" });
      if (res.status !== 0)
        log(`Plugin bundle exited with code ${res.status ?? "null"} (ignored).`);
    }
    return { built: true };
  };

  const init = (cwd: string, initOpts: Parameters<OnboardDeps["init"]>[1]) =>
    runInit(
      cwd,
      initOpts,
      defaultInitDeps({ assumeYes: initOpts.yes, curateEntry: opts.curateEntry }),
    );

  const configureScope = async (
    repoRoot: string,
  ): Promise<{ added: boolean; skipped?: string }> => {
    let curateEntry: string;
    try {
      curateEntry = resolveCurateEntry(opts.curateEntry);
    } catch (err) {
      return { added: false, skipped: `commonwealth-curate not found: ${(err as Error).message}` };
    }
    const res = spawnSync("node", [curateEntry, "scope", "allow", repoRoot], { stdio: "ignore" });
    if (res.error || res.status !== 0) {
      const reason = res.error ? res.error.message : `exit code ${res.status ?? "null"}`;
      return { added: false, skipped: `scope allow failed (${reason})` };
    }
    return { added: true };
  };

  const setAutoAdr = async (
    brainDir: string,
    on: boolean,
  ): Promise<{ set: boolean; skipped?: string }> => {
    let curateEntry: string;
    try {
      curateEntry = resolveCurateEntry(opts.curateEntry);
    } catch (err) {
      return { set: false, skipped: `commonwealth-curate not found: ${(err as Error).message}` };
    }
    const verb = on ? "enable" : "disable";
    const res = spawnSync("node", [curateEntry, "feature", verb, "autoAdr", "--dir", brainDir], {
      stdio: "ignore",
    });
    if (res.error || res.status !== 0) {
      const reason = res.error ? res.error.message : `exit code ${res.status ?? "null"}`;
      return { set: false, skipped: `feature ${verb} autoAdr failed (${reason})` };
    }
    return { set: true };
  };

  const setRemote = async (
    brainDir: string,
    url: string,
  ): Promise<{ set: boolean; skipped?: string }> => {
    const existing = spawnSync("git", ["-C", brainDir, "remote", "get-url", "origin"], {
      stdio: "ignore",
    });
    if (existing.status === 0) return { set: false, skipped: "origin exists" };

    const add = spawnSync("git", ["-C", brainDir, "remote", "add", "origin", url], {
      stdio: "ignore",
    });
    if (add.error || add.status !== 0) {
      const reason = add.error ? add.error.message : `exit code ${add.status ?? "null"}`;
      return { set: false, skipped: `git remote add failed (${reason})` };
    }
    return { set: true };
  };

  /**
   * Install the Commonwealth plugin at USER scope via the repo marketplace (ADR-0012),
   * replacing the old raw local-scope `claude mcp add`. Steps, all best-effort and
   * idempotent, NONE throwing:
   *   a) refresh the vendored plugin bundle (so the plugin's vendor/ is up to date);
   *   b) `claude plugin marketplace add <repoRoot>` — skipped if a `commonwealth` marketplace
   *      is already configured (checked via `marketplace list`);
   *   c) `claude plugin install commonwealth@commonwealth` — skipped if already installed
   *      (checked via `plugin list`);
   *   d) remove a STALE raw `commonwealth` MCP registration (`claude mcp remove -s local`) so
   *      it doesn't shadow the plugin's `commonwealth` server.
   * The brain is resolved per repo by the plugin + its SessionStart hook, so no brain dir is
   * pinned here.
   */
  const installPlugin = async (): Promise<{ installed: boolean; skipped?: string }> => {
    if (!hasExecutable("claude")) {
      return { installed: false, skipped: "claude CLI not found" };
    }

    // (a) Refresh the vendored bundle so the installed plugin runs the current build.
    const bundle = path.join(repoRoot, "packages", "plugin", "scripts", "bundle.mjs");
    if (existsSync(bundle)) {
      const res = spawnSync("node", [bundle], { cwd: repoRoot, stdio: "inherit" });
      if (res.status !== 0)
        log(`Plugin bundle exited with code ${res.status ?? "null"} (ignored).`);
    }

    // (b) Register the repo as a marketplace unless a `commonwealth` marketplace already exists.
    if (!hasClaudeEntry(["plugin", "marketplace", "list"], "commonwealth")) {
      const add = spawnSync("claude", ["plugin", "marketplace", "add", repoRoot], {
        stdio: "inherit",
      });
      if (add.error || add.status !== 0) {
        return {
          installed: false,
          skipped: `claude plugin marketplace add failed (code ${add.status ?? "null"})`,
        };
      }
    }

    // (c) Install the plugin unless it is already installed.
    if (!hasClaudeEntry(["plugin", "list"], "commonwealth")) {
      const install = spawnSync("claude", ["plugin", "install", "commonwealth@commonwealth"], {
        stdio: "inherit",
      });
      if (install.error || install.status !== 0) {
        return {
          installed: false,
          skipped: `claude plugin install failed (code ${install.status ?? "null"})`,
        };
      }
    }

    // (d) Clean up any stale raw local-scope MCP registration so it can't shadow the plugin.
    const staleGet = spawnSync("claude", ["mcp", "get", "commonwealth"], { stdio: "ignore" });
    if (staleGet.status === 0) {
      spawnSync("claude", ["mcp", "remove", "commonwealth", "-s", "local"], { stdio: "ignore" });
    }

    return { installed: true };
  };

  const startDaemon = async (
    brainDir: string,
  ): Promise<{ started: boolean; alreadyRunning?: boolean; skipped?: string }> => {
    const syncEntry = distEntry("sync");
    if (!existsSync(syncEntry)) {
      return { started: false, skipped: "sync daemon not built" };
    }
    const status = spawnSync("node", [syncEntry, "status", "--dir", brainDir], {
      encoding: "utf8",
    });
    const output = `${status.stdout ?? ""}${status.stderr ?? ""}`;
    if (/\brunning on\b/.test(output) && !/\bnot running on\b/.test(output)) {
      return { started: false, alreadyRunning: true };
    }
    try {
      const child = spawn("node", [syncEntry, "start", "--dir", brainDir], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return { started: true };
    } catch (err) {
      return { started: false, skipped: `failed to start daemon: ${(err as Error).message}` };
    }
  };

  const registerBrain = async (
    folder: string,
    brainDir: string,
  ): Promise<{ mapped: boolean; linked: boolean; skipped?: string }> => {
    try {
      const map = await core.addRegistryMapping(folder, brainDir);
      const link = await core.linkBrain(path.basename(brainDir), brainDir);
      return { mapped: map.added || map.updated, linked: link.linked, skipped: link.skipped };
    } catch (err) {
      return { mapped: false, linked: false, skipped: (err as Error).message };
    }
  };

  const seedFrom = async (
    brainDir: string,
    repoDir: string,
  ): Promise<{ staged: number; skipped?: string }> => {
    let curateEntry: string;
    try {
      curateEntry = resolveCurateEntry(opts.curateEntry);
    } catch (err) {
      return { staged: 0, skipped: `commonwealth-curate not found: ${(err as Error).message}` };
    }
    const seedEntry = distEntry("seed");
    if (!existsSync(seedEntry)) return { staged: 0, skipped: "seed CLI not built" };

    return new Promise((resolve) => {
      const gather = spawn("node", [seedEntry, "gather", "--repo", repoDir], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      const capture = spawn("node", [curateEntry, "capture", "--dir", brainDir, "--force"], {
        stdio: ["pipe", "pipe", "inherit"],
      });

      let settled = false;
      const done = (result: { staged: number; skipped?: string }): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      gather.on("error", (err) =>
        done({ staged: 0, skipped: `seed spawn failed (${err.message})` }),
      );
      capture.on("error", (err) =>
        done({ staged: 0, skipped: `capture spawn failed (${err.message})` }),
      );

      gather.stdout.pipe(capture.stdin);

      let out = "";
      capture.stdout.setEncoding("utf8");
      capture.stdout.on("data", (chunk: string) => {
        out += chunk;
      });

      capture.on("close", (code) => {
        if (code !== 0) {
          done({ staged: 0, skipped: `capture exited with code ${code ?? "null"}` });
          return;
        }
        const staged = out.split("\n").filter((line) => line.trim().length > 0).length;
        done({ staged });
      });
    });
  };

  const ensureUserConfig = async (): Promise<{ path: string }> => {
    const configPath =
      process.env.COMMONWEALTH_CONFIG ?? path.join(os.homedir(), ".commonwealth", "config.json");
    if (!existsSync(configPath)) {
      try {
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(
          configPath,
          `${JSON.stringify({ allow: [], deny: [] }, null, 2)}\n`,
          "utf8",
        );
      } catch (err) {
        log(`Could not create scope config at ${configPath}: ${(err as Error).message}`);
      }
    }
    return { path: configPath };
  };

  return {
    ensureBuilt,
    init,
    configureScope,
    registerBrain,
    seedFrom,
    ensureUserConfig,
    setAutoAdr,
    setRemote,
    installPlugin,
    startDaemon,
    confirm: promptConfirm,
    log,
  };
}
