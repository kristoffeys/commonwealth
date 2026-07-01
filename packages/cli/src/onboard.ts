import path from "node:path";
import { findRepoRoot } from "./init.js";
import type { InitOptions, InitResult } from "./init.js";
import type { Prompter } from "./prompt.js";
import { findGitRepos } from "./discover.js";

/**
 * Flags that shape a full `commonwealth init` orchestration. The step gates (`seed`, `mcp`,
 * `daemon`, `build`, `scope`) default to `true` when omitted; pass `false` to skip that step. This
 * is a type alias (not an interface) so it stays free of empty-interface lint noise.
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
  /** Add the repo root to the capture allowlist (`scope allow`). Default: true. */
  scope?: boolean;
  /** Enable auto-ADR capture for the brain. Default: false. */
  autoAdr?: boolean;
  /** Add this URL as the brain's git `origin` remote. Default: undefined (skip). */
  remote?: string;
  /**
   * Folders to sync into this brain: each is added to the capture allowlist and pinned to the
   * brain via a `.commonwealth/brain` marker. Default: `[repoRoot]`.
   */
  syncFolders?: string[];
  /**
   * Repos to mine (seed) into the brain now. Default: {@link OnboardOptions.syncFolders} when
   * seeding is enabled, else `[]`.
   */
  seedRepos?: string[];
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
  /** Idempotently add `folder` to the capture allowlist (`scope allow`; de-dupes). */
  configureScope(folder: string): Promise<{ added: boolean; skipped?: string }>;
  /** Pin `folder` to `brainDir` via the `.commonwealth/brain` marker (idempotent). */
  writeMarker(folder: string, brainDir: string): Promise<{ written: boolean; skipped?: string }>;
  /** Mine `repoDir` and stage the candidates into `brainDir`'s review queue. */
  seedFrom(brainDir: string, repoDir: string): Promise<{ staged: number; skipped?: string }>;
  /**
   * Ensure the per-user scope config file exists (creating an empty one if missing) and return
   * its resolved path. Called near the end of onboarding regardless of scope choices.
   */
  ensureUserConfig(): Promise<{ path: string }>;
  /** Enable/disable auto-ADR capture for `brainDir`. */
  setAutoAdr(brainDir: string, on: boolean): Promise<{ set: boolean; skipped?: string }>;
  /** Add `url` as the brain's git `origin` remote unless one already exists. */
  setRemote(brainDir: string, url: string): Promise<{ set: boolean; skipped?: string }>;
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
  /** How many candidate notes were staged into the review queue (summed across seeded repos). */
  staged: number;
  /** How many folders were added to the capture allowlist + pinned to the brain. */
  scopedFolders: number;
  /** How many repos were seeded (mined) into the brain. */
  seededRepos: number;
  /** Resolved path of the per-user scope config file (always ensured to exist). */
  scopeConfigPath: string;
  /** Short allowlist status string (e.g. `added`, `skipped`). */
  scope: string;
  /** Short auto-ADR status string (e.g. `enabled`, `skipped`). */
  autoAdr: string;
  /** Short brain-remote status string (e.g. `set`, `origin exists`, `skipped`). */
  remote: string;
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
  const doScope = opts.scope !== false;
  const doAutoAdr = opts.autoAdr === true;
  const doRemote = typeof opts.remote === "string" && opts.remote.trim().length > 0;
  const doMcp = opts.mcp !== false;
  const doDaemon = opts.daemon !== false;

  const repoRoot = findRepoRoot(cwd);
  const syncFolders =
    opts.syncFolders && opts.syncFolders.length > 0 ? opts.syncFolders : [repoRoot];
  const seedRepos =
    opts.seedRepos && opts.seedRepos.length > 0 ? opts.seedRepos : doSeed ? syncFolders : [];

  const brainLabel = opts.brain ?? "the project's default brain dir";
  const plan = [
    doBuild ? "build the workspace if needed" : null,
    `create brain at ${brainLabel}`,
    doScope ? `sync ${syncFolders.length} folder(s) into the brain` : null,
    seedRepos.length > 0 ? `seed from ${seedRepos.length} repo(s)` : null,
    doAutoAdr ? "enable auto-ADR" : null,
    doRemote ? `set brain remote to ${opts.remote}` : null,
    doMcp ? "register the MCP server" : null,
    doDaemon ? "start the sync daemon" : null,
    "ensure the per-user scope config exists",
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
        scopedFolders: 0,
        seededRepos: 0,
        scopeConfigPath: "",
        scope: "skipped",
        autoAdr: "skipped",
        remote: "skipped",
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

  // Create/join the brain only; seeding is done per-repo below via seedFrom.
  const initResult = await deps.init(cwd, {
    brain: opts.brain,
    yes: opts.yes,
    reseed: opts.reseed,
    seed: false,
  });
  const brainDir = initResult.brainDir;

  let scopedFolders = 0;
  let scope = "skipped";
  if (doScope) {
    for (const folder of syncFolders) {
      const scopeRes = await deps.configureScope(folder);
      if (scopeRes.skipped) {
        deps.log(`WARNING: scope step skipped for ${folder}: ${scopeRes.skipped}`);
      } else if (scopeRes.added) {
        scopedFolders += 1;
        deps.log(`Scope: added ${folder}`);
      } else {
        deps.log(`Scope: ${folder} already allowed`);
      }

      const markerRes = await deps.writeMarker(folder, brainDir);
      if (markerRes.skipped) {
        deps.log(`WARNING: marker step skipped for ${folder}: ${markerRes.skipped}`);
      } else {
        deps.log(`Marker: pinned ${folder} -> ${brainDir}`);
      }
    }
    scope = scopedFolders > 0 ? `added ${scopedFolders}` : "none added";
  }

  let staged = 0;
  let seededRepos = 0;
  if (seedRepos.length > 0) {
    for (const repo of seedRepos) {
      const seedRes = await deps.seedFrom(brainDir, repo);
      if (seedRes.skipped) {
        deps.log(`WARNING: seed step skipped for ${repo}: ${seedRes.skipped}`);
      } else {
        staged += seedRes.staged;
        seededRepos += 1;
        deps.log(`Seed: staged ${seedRes.staged} from ${repo}`);
      }
    }
  }

  let autoAdr = "skipped";
  if (doAutoAdr) {
    const res = await deps.setAutoAdr(brainDir, true);
    autoAdr = res.skipped ?? (res.set ? "enabled" : "not enabled");
    deps.log(`Auto-ADR: ${autoAdr}`);
  }

  let remote = "skipped";
  if (doRemote) {
    const res = await deps.setRemote(brainDir, opts.remote as string);
    remote = res.skipped ?? (res.set ? "set" : "not set");
    deps.log(`Remote: ${remote}`);
  }

  let mcp = "skipped";
  if (doMcp) {
    const res = await deps.registerMcp(brainDir);
    if (res.skipped) {
      deps.log(`WARNING: MCP step skipped: ${res.skipped}`);
      mcp = res.skipped;
    } else {
      mcp = res.registered ? "registered" : "not registered";
      deps.log(`MCP: ${mcp}`);
    }
  }

  let daemon = "skipped";
  if (doDaemon) {
    const res = await deps.startDaemon(brainDir);
    if (res.skipped) {
      deps.log(`WARNING: daemon step skipped: ${res.skipped}`);
      daemon = res.skipped;
    } else if (res.alreadyRunning) {
      daemon = "already running";
      deps.log(`Daemon: ${daemon}`);
    } else {
      daemon = res.started ? "started" : "not started";
      deps.log(`Daemon: ${daemon}`);
    }
  }

  // Always ensure the per-user scope config exists, regardless of scope choices above.
  const { path: scopeConfigPath } = await deps.ensureUserConfig();

  deps.log(
    `Done. mode=${initResult.mode} brain=${brainDir} staged=${staged} ` +
      `scopedFolders=${scopedFolders} seededRepos=${seededRepos} ` +
      `scope=${scope} autoAdr=${autoAdr} remote=${remote} mcp=${mcp} daemon=${daemon}. ` +
      `Scope config: ${scopeConfigPath}. ` +
      "Open a Claude session here and ask it something your team knows.",
  );

  return {
    brainDir,
    mode: initResult.mode,
    built,
    staged,
    scopedFolders,
    seededRepos,
    scopeConfigPath,
    scope,
    autoAdr,
    remote,
    mcp,
    daemon,
  };
}

/** The answers a wizard collects, ready to be turned into {@link OnboardOptions}. */
export interface WizardAnswers {
  brain: string;
  scope: boolean;
  seed: boolean;
  mcp: boolean;
  daemon: boolean;
  autoAdr: boolean;
  remote: string;
}

/** Defaults the wizard seeds its prompts with (Enter accepts each). */
export interface WizardDefaults {
  brain: string;
  /**
   * The project's repo root — the fallback sync/seed target when no sibling repos are found, and
   * the base whose parent is offered as the default scan directory.
   */
  repoRoot: string;
  scope: boolean;
  seed: boolean;
  mcp: boolean;
  daemon: boolean;
  autoAdr: boolean;
}

/** What {@link runWizard} produces: the assembled options, or an abort signal. */
export type WizardOutcome =
  { proceed: true; opts: OnboardOptions } | { proceed: false; opts: null };

/** Injectable side effects for {@link runWizard} (defaults to the real discovery). */
export interface WizardDeps {
  /** Scan `baseDir` for git repositories (defaults to {@link findGitRepos}). */
  scan(baseDir: string): Promise<string[]>;
}

/** Real wizard deps: scan the filesystem for git repos. */
function defaultWizardDeps(): WizardDeps {
  return { scan: (baseDir) => findGitRepos(baseDir) };
}

/**
 * Drive the interactive wizard: ask each choice with a sensible default (Enter accepts), then a
 * final `Proceed?` confirm. Pure orchestration over a {@link Prompter} + {@link WizardDeps}, so
 * tests script answers with a fake and never touch a real TTY or filesystem. A declined
 * `Proceed?` returns `{ proceed: false }` and the caller must perform ZERO side effects.
 *
 * After the brain prompt it asks which directory to scan for projects, discovers the git repos
 * beneath it, and lets the user multi-select which folders to SYNC into the brain and which repos
 * to SEED now (seed defaults to the sync selection). When nothing is found it falls back to the
 * repo root for both.
 *
 * The returned `opts` carry `yes: true` because the wizard has already confirmed — the caller must
 * NOT prompt again inside {@link runOnboard}.
 *
 * @param defaults Per-prompt defaults (usually derived from environment probing).
 * @param prompter The interactive prompter.
 * @param deps Injectable discovery (defaults to scanning the real filesystem).
 * @returns A {@link WizardOutcome}: the options to run, or an abort.
 */
export async function runWizard(
  defaults: WizardDefaults,
  prompter: Prompter,
  deps: WizardDeps = defaultWizardDeps(),
): Promise<WizardOutcome> {
  const brain = await prompter.text("Brain directory", defaults.brain);

  const scanDefault = path.dirname(defaults.repoRoot);
  const scanDir = await prompter.text("Scan which directory for projects?", scanDefault);
  const repos = await deps.scan(scanDir);

  let syncFolders: string[];
  let seedRepos: string[];
  if (repos.length > 0) {
    const items = repos.map((r) => ({ label: r, value: r }));
    const allTrue = repos.map(() => true);
    syncFolders = await prompter.select("Folders to SYNC into this brain", items, allTrue);
    const seedDefault = repos.map((r) => syncFolders.includes(r));
    seedRepos = await prompter.select("Repos to SEED from now", items, seedDefault);
  } else {
    syncFolders = [defaults.repoRoot];
    seedRepos = [defaults.repoRoot];
  }

  const mcp = await prompter.confirm("Register MCP with Claude Code?", defaults.mcp);
  const daemon = await prompter.confirm("Start the sync daemon?", defaults.daemon);
  const autoAdr = await prompter.confirm("Enable auto-ADR?", defaults.autoAdr);
  const remote = await prompter.text("Brain git remote (blank to skip)", "");

  const opts: OnboardOptions = {
    brain: brain.trim() === "" ? undefined : brain,
    yes: true,
    seed: seedRepos.length > 0,
    mcp,
    daemon,
    scope: true,
    autoAdr,
    remote: remote.trim() === "" ? undefined : remote,
    syncFolders,
    seedRepos,
  };

  const ok = await prompter.confirm("Proceed?", true);
  if (!ok) return { proceed: false, opts: null };
  return { proceed: true, opts };
}
