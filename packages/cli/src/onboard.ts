import type { InitOptions, InitResult } from "./init.js";

/**
 * Flags that shape a full `commonwealth init` orchestration. The step gates (`seed`, `mcp`,
 * `daemon`, `build`) default to `true` when omitted; pass `false` to skip that step. This is a
 * type alias (not an interface) so it stays free of empty-interface lint noise.
 */
export type OnboardOptions = {
  /** Explicit brain directory to create/use instead of the project default. */
  brain?: string;
  /** Skip the whole-plan confirmation and run non-interactively. */
  yes?: boolean;
  /** Re-run seeding even if this project already resolves to a brain. */
  reseed?: boolean;
  /** Gather + stage seed candidates. Default: true. `false` skips staging. */
  seed?: boolean;
  /** Register the MCP server with the `claude` CLI. Default: true. */
  mcp?: boolean;
  /** Start the sync daemon for the brain. Default: true. */
  daemon?: boolean;
  /** Build/bundle the workspace if dist artifacts are missing. Default: true. */
  build?: boolean;
};

/**
 * Injected side effects so {@link runOnboard} is deterministic and unit-testable without
 * building the workspace, delegating to `runInit`, spawning `claude`, or starting a daemon.
 */
export interface OnboardDeps {
  /** Build the workspace when dist artifacts are missing; a no-op (with a note) otherwise. */
  ensureBuilt(): Promise<{ built: boolean; skipped?: string }>;
  /** Create/seed/join the brain (delegates to `runInit` with real init deps). */
  init(cwd: string, initOpts: InitOptions): Promise<InitResult>;
  /** Idempotently register the MCP server for `brainDir` with the `claude` CLI. */
  registerMcp(brainDir: string): Promise<{ registered: boolean; skipped?: string }>;
  /** Start the sync daemon for `brainDir`, or report it already running. */
  startDaemon(
    brainDir: string,
  ): Promise<{ started: boolean; alreadyRunning?: boolean; skipped?: string }>;
  /** Ask the user a yes/no question; resolves to their answer. */
  confirm(message: string): Promise<boolean>;
  /** Emit a human-facing line (diagnostics stream, never stdout data). */
  log(message: string): void;
}

/** What a {@link runOnboard} run did, for the CLI to summarize and tests to assert on. */
export interface OnboardResult {
  /** The brain directory this project is now pinned to. */
  brainDir: string;
  /** Delegated `runInit` mode: `new` / `join` / `skipped`. */
  mode: InitResult["mode"];
  /** Whether {@link OnboardDeps.ensureBuilt} actually built anything. */
  built: boolean;
  /** How many candidate notes were staged into the review queue. */
  staged: number;
  /** Short MCP status string (e.g. `registered`, `already registered`, `skipped`). */
  mcp: string;
  /** Short daemon status string (e.g. `started`, `already running`, `skipped`). */
  daemon: string;
}

/**
 * Orchestrate the full `commonwealth init`: build the workspace (if needed), create/seed/join
 * the brain, register the MCP server, and start the sync daemon — a single idempotent command.
 * Deterministic and side-effect-free except through `deps`.
 *
 * Flow: build a plan and log it; unless `--yes`, confirm the whole plan (a decline does NOTHING
 * and returns early); then run each enabled step in order — ensureBuilt, init, registerMcp,
 * startDaemon — and log a done summary. Each step is individually gated by its option and every
 * step is idempotent, so re-running is safe.
 *
 * @param cwd The directory `commonwealth init` was invoked from.
 * @param opts Parsed CLI flags (step gates default to enabled).
 * @param deps Injected side effects.
 * @returns A structured summary of what happened.
 */
export async function runOnboard(
  cwd: string,
  opts: OnboardOptions,
  deps: OnboardDeps,
): Promise<OnboardResult> {
  const doBuild = opts.build !== false;
  const doSeed = opts.seed !== false;
  const doMcp = opts.mcp !== false;
  const doDaemon = opts.daemon !== false;

  const brainLabel = opts.brain ?? "the project's default brain dir";
  const plan = [
    doBuild ? "build the workspace if needed" : null,
    doSeed ? `create/seed brain at ${brainLabel}` : `create brain at ${brainLabel} (no seed)`,
    doMcp ? "register the MCP server" : null,
    doDaemon ? "start the sync daemon" : null,
  ].filter((step): step is string => step !== null);
  deps.log(`Will: ${plan.join(", ")}.`);

  if (!opts.yes) {
    const ok = await deps.confirm("Proceed with the plan above?");
    if (!ok) {
      deps.log("Aborted. Nothing was changed.");
      return {
        brainDir: opts.brain ?? "",
        mode: "skipped",
        built: false,
        staged: 0,
        mcp: "skipped",
        daemon: "skipped",
      };
    }
  }

  let built = false;
  if (doBuild) {
    const res = await deps.ensureBuilt();
    built = res.built;
    if (res.skipped) deps.log(`Build: ${res.skipped}`);
    else deps.log(built ? "Build: built workspace." : "Build: dist up to date.");
  }

  const initResult = await deps.init(cwd, {
    brain: opts.brain,
    yes: opts.yes,
    reseed: opts.reseed,
    seed: doSeed,
  });
  const brainDir = initResult.brainDir;

  let mcp = "skipped";
  if (doMcp) {
    const res = await deps.registerMcp(brainDir);
    mcp = res.skipped ?? (res.registered ? "registered" : "not registered");
    deps.log(`MCP: ${mcp}`);
  }

  let daemon = "skipped";
  if (doDaemon) {
    const res = await deps.startDaemon(brainDir);
    if (res.skipped) daemon = res.skipped;
    else if (res.alreadyRunning) daemon = "already running";
    else daemon = res.started ? "started" : "not started";
    deps.log(`Daemon: ${daemon}`);
  }

  deps.log(
    `Done. mode=${initResult.mode} brain=${brainDir} staged=${initResult.staged} ` +
      `mcp=${mcp} daemon=${daemon}. ` +
      "Open a Claude session here and ask it something your team knows.",
  );

  return { brainDir, mode: initResult.mode, built, staged: initResult.staged, mcp, daemon };
}
