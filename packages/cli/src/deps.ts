import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import path from "node:path";
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
      const child = spawn("node", [curateEntry, "capture", "--dir", brainDir], {
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
    writeMarker: (repoDir, brainDir) => core.setBrainMarker(repoDir, brainDir),
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
 * Wire the real {@link OnboardDeps}: a dist-presence check that triggers `pnpm -r build` + the
 * plugin bundle, `runInit` for the brain core, an idempotent `claude mcp add`, and a detached
 * sync daemon. Every step degrades to a `skipped` note rather than throwing, so a missing
 * `pnpm`/`claude` never aborts onboarding. Pure orchestration lives in {@link runOnboard}.
 *
 * @param opts Optional overrides ({@link DefaultOnboardDepsOptions}).
 * @returns A fully-wired {@link OnboardDeps}.
 */
export function defaultOnboardDeps(opts: DefaultOnboardDepsOptions = {}): OnboardDeps {
  const log = (m: string): void => {
    process.stderr.write(m + "\n");
  };

  const repoRoot = opts.repoRoot ?? findRepoRoot(process.cwd());
  const distEntry = (pkg: string): string =>
    path.join(repoRoot, "packages", pkg, "dist", "index.js");

  const ensureBuilt = async (): Promise<{ built: boolean; skipped?: string }> => {
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

  const registerMcp = async (
    brainDir: string,
  ): Promise<{ registered: boolean; skipped?: string }> => {
    if (!hasExecutable("claude")) {
      return { registered: false, skipped: "claude CLI not found" };
    }
    const get = spawnSync("claude", ["mcp", "get", "commonwealth"], { stdio: "ignore" });
    if (get.status === 0) return { registered: false, skipped: "already registered" };

    const add = spawnSync(
      "claude",
      [
        "mcp",
        "add",
        "commonwealth",
        "--env",
        `COMMONWEALTH_BRAIN_DIR=${brainDir}`,
        "--",
        "node",
        distEntry("mcp"),
      ],
      { stdio: "inherit" },
    );
    if (add.error || add.status !== 0) {
      return { registered: false, skipped: `claude mcp add failed (code ${add.status ?? "null"})` };
    }
    return { registered: true };
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

  return {
    ensureBuilt,
    init,
    configureScope,
    setAutoAdr,
    setRemote,
    registerMcp,
    startDaemon,
    confirm: promptConfirm,
    log,
  };
}
