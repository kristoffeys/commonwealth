import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import path from "node:path";
import * as core from "@commonwealth/core";
import type { NewNoteInput } from "@commonwealth/core";
import { gatherCandidates } from "@commonwealth/seed";
import type { InitDeps } from "./init.js";

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
