import { spawnSync } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import { cmdConfig, cmdReseed, delegateCurate, delegateSync } from "./commands.js";
import { defaultOnboardDeps } from "./deps.js";
import { defaultDoctorEnv, diagnose, formatDoctorText } from "./doctor.js";
import { defaultBrainDir } from "./init.js";
import { runOnboard, runWizard, type OnboardOptions, type WizardDefaults } from "./onboard.js";
import { createReadlinePrompter, isInteractive, type Prompter } from "./prompt.js";

export { runInit, findRepoRoot, defaultBrainDir } from "./init.js";
export type { InitOptions, InitDeps, InitResult, InitBySource } from "./init.js";
export { defaultInitDeps, defaultOnboardDeps } from "./deps.js";
export { runOnboard, runWizard } from "./onboard.js";
export type {
  OnboardOptions,
  OnboardDeps,
  OnboardResult,
  WizardAnswers,
  WizardDefaults,
  WizardDeps,
  WizardOutcome,
} from "./onboard.js";
export {
  isInteractive,
  createReadlinePrompter,
  parseConfirm,
  parseText,
  parseSelection,
} from "./prompt.js";
export type { Prompter } from "./prompt.js";
export { findGitRepos } from "./discover.js";
export type { FindGitReposOptions } from "./discover.js";
export { diagnose, defaultDoctorEnv, formatDoctorText } from "./doctor.js";
export type { DoctorReport, DoctorCheck, DoctorEnv, CheckStatus } from "./doctor.js";

/** Print `commonwealth` usage to stderr. */
function printUsage(): void {
  process.stderr.write(
    [
      "commonwealth — git-backed markdown team-brain",
      "",
      "Usage:",
      "  commonwealth init      [flags]                 onboard: build, create/join brain, plugin, daemon",
      "  commonwealth reseed    [<repo>...] [--all]     mine repo(s) into the mapped brain and capture",
      "  commonwealth config    <list | get <k> | set <k> <v>>   read/set the brain's shared config",
      "  commonwealth status                            review queue + sync-daemon state",
      "  commonwealth doctor    [--fix] [--json]        diagnose the install/sync chain; --fix restarts a dead daemon",
      "  commonwealth health                            freshness/trust rollup for the brain",
      "  commonwealth consolidate  [--dry-run]          supersede near-duplicate canon notes",
      "  commonwealth sync      <start | stop | once>   control/run the sync daemon",
      "  commonwealth pending                           list notes awaiting review",
      "  commonwealth promote   <id...> | --all         approve staged notes into canon",
      "  commonwealth reject    <id...>                 discard staged notes",
      "  commonwealth scope     <show | allow <p> | deny <p> | check>   per-user capture scope",
      "  commonwealth recall    <query>                 search the brain",
      "",
      "All commands resolve the brain from the registry for the current directory — no --dir needed.",
      "",
      "init flags: [--brain <dir>] [--yes] [--reseed] [--auto-adr] [--remote <url>]",
      "            [--sync <dir,dir,...>] [--seed-repo <dir,dir,...>]",
      "            [--no-scope] [--no-seed] [--no-plugin] [--no-daemon] [--no-build]",
      "",
      "`init` is a single idempotent command: it builds the workspace (if needed), creates or",
      "joins the brain, syncs one or more folders into it (allowlist + a global-registry mapping",
      "with a ~/.commonwealth/brains/<name> symlink), seeds it from one or more repos, installs",
      "the Commonwealth plugin (global MCP + session hooks), and starts the sync daemon. Run in a",
      "terminal without --yes for an interactive wizard that scans for and lets you multi-select",
      "folders/repos; with --yes (or non-interactively) it uses defaults + flags and never prompts.",
      "",
      "Options:",
      "  --brain <dir>          Create/use the brain at <dir> (default: ~/.commonwealth/brains/<project>)",
      "  --yes                  Run non-interactively; skip the wizard and all prompts",
      "  --reseed               Re-seed even if this project already resolves to a brain",
      "  --auto-adr             Enable auto-ADR capture for the brain",
      "  --remote <url>         Add <url> as the brain's git origin remote",
      "  --sync <dir,dir,...>   Folders to sync into the brain (default: this repo)",
      "  --seed-repo <dir,...>  Repos to seed from now (default: the --sync folders)",
      "  --no-scope             Skip adding folders to the capture allowlist",
      "  --no-seed       Create the brain but skip gathering/staging seed candidates",
      "  --no-plugin     Skip installing the Commonwealth plugin (alias: --no-mcp)",
      "  --no-daemon     Skip starting the sync daemon",
      "  --no-build      Skip the workspace build even if dist artifacts are missing",
      "",
    ].join("\n"),
  );
}

/**
 * `commonwealth` CLI entry. Parses argv, dispatches `init` to the full {@link runOnboard}
 * orchestration, prints the plan + a one-line summary to stderr, and resolves the exit code.
 * Diagnostics go to stderr; there is no stdout data contract for `init`. Unknown commands and
 * `--help` print usage.
 *
 * `parseArgs` has no native boolean negation, so `--no-seed`/`--no-mcp`/`--no-daemon`/`--no-build`
 * are stripped from argv here and turned into `false` gates before parsing the rest.
 *
 * @param argv Arguments after `node <script>` (i.e. `process.argv.slice(2)`).
 * @returns Exit code: 0 on success, 2 on usage error.
 */
export async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h") {
    printUsage();
    return command === undefined ? 2 : 0;
  }

  // Unified subcommand surface (#93). `reseed`/`config` compose core+seed; the rest delegate to
  // the registry-aware curate/sync binaries (inheriting cwd, so they hit the mapped brain).
  switch (command) {
    case "init":
      return cmdInit(rest);
    case "reseed":
      return cmdReseed(rest);
    case "config":
      return cmdConfig(rest);
    case "status": {
      const queue = await delegateCurate(["list"]);
      const daemon = await delegateSync(["status"]);
      return queue || daemon;
    }
    case "doctor":
      return cmdDoctor(rest);
    case "sync": {
      const sub = rest[0] === "once" ? "sync" : (rest[0] ?? "status");
      return delegateSync([sub, ...rest.slice(1)]);
    }
    case "health":
      return delegateCurate(["health"]);
    case "consolidate":
      return delegateCurate(["consolidate", ...rest]);
    case "pending":
      return delegateCurate(["list"]);
    case "promote":
      return delegateCurate(rest.includes("--all") ? ["approve-all"] : ["approve", ...rest]);
    case "reject":
      return delegateCurate(["reject", ...rest]);
    case "scope":
      return delegateCurate(["scope", ...rest]);
    case "recall":
      return delegateCurate(["context", "--cwd", process.cwd(), "--query", rest.join(" ")]);
    default:
      process.stderr.write(`Unknown command: ${command}\n`);
      printUsage();
      return 2;
  }
}

/**
 * `commonwealth doctor [--fix] [--json]` — walk the install/sync chain and print pass/fail with
 * the exact one-line fix per failed link. `--json` emits the structured {@link DoctorReport} on
 * stdout (for agents/CI); `--fix` restarts a dead sync daemon (the only self-heal). Exit 0 when no
 * link failed, 1 otherwise — so CI can gate on it.
 */
async function cmdDoctor(rest: string[]): Promise<number> {
  const json = rest.includes("--json");
  const fix = rest.includes("--fix");
  const report = await diagnose(defaultDoctorEnv(process.cwd()), { fix });
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stderr.write(formatDoctorText(report));
  return report.ok ? 0 : 1;
}

/** `commonwealth init` — the onboarding orchestrator (build → create/seed/join → plugin → daemon). */
async function cmdInit(rest: string[]): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    printUsage();
    return 0;
  }

  // parseArgs has no native negation; consume --no-* flags first and derive the gates.
  // `--no-plugin` is the canonical gate; `--no-mcp` is a backward-compatible alias.
  const negations = [
    "--no-scope",
    "--no-seed",
    "--no-plugin",
    "--no-mcp",
    "--no-daemon",
    "--no-build",
  ];
  const scope = !rest.includes("--no-scope");
  const seed = !rest.includes("--no-seed");
  const plugin = !rest.includes("--no-plugin") && !rest.includes("--no-mcp");
  const daemon = !rest.includes("--no-daemon");
  const build = !rest.includes("--no-build");
  const positional = rest.filter((a) => !negations.includes(a));

  let values: {
    brain?: string;
    yes?: boolean;
    reseed?: boolean;
    "auto-adr"?: boolean;
    remote?: string;
    sync?: string;
    "seed-repo"?: string;
  };
  try {
    ({ values } = parseArgs({
      args: positional,
      options: {
        brain: { type: "string" },
        yes: { type: "boolean", default: false },
        reseed: { type: "boolean", default: false },
        "auto-adr": { type: "boolean", default: false },
        remote: { type: "string" },
        sync: { type: "string" },
        "seed-repo": { type: "string" },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    printUsage();
    return 2;
  }

  const cwd = process.cwd();
  // The scope/registry/brain-name base is the invocation dir, not the git root (#61).
  const projectDir = path.resolve(cwd);

  // Non-interactive without --yes: do NOTHING but point the user at a terminal. This runs BEFORE
  // any executable probe (`hasExecutable`) or dep resolution (`defaultOnboardDeps`), so the path
  // is fully side-effect-free and can't fail — a subprocess spawned here under CI fork-pressure
  // could throw and exit 1, which would (and did) flake the release gate. "does not touch anything."
  const interactive = isInteractive();
  if (!interactive && !values.yes) {
    process.stderr.write("Non-interactive: re-run in a terminal or pass --yes.\n");
    return 0;
  }

  const claudePresent = hasExecutable("claude");
  const deps = defaultOnboardDeps({ curateEntry: process.env.COMMONWEALTH_CURATE_BIN });

  // Parse a comma-separated dir list into resolved absolute paths (blanks dropped).
  const splitDirs = (raw: string | undefined): string[] | undefined => {
    if (raw === undefined) return undefined;
    const dirs = raw
      .split(",")
      .map((d) => d.trim())
      .filter((d) => d.length > 0);
    return dirs.length > 0 ? dirs : undefined;
  };

  let opts: OnboardOptions;
  let prompter: Prompter | null = null;

  try {
    if (interactive && !values.yes) {
      // Interactive terminal, no --yes: run the wizard.
      const defaults: WizardDefaults = {
        brain: defaultBrainDir(projectDir),
        projectDir,
        scope: true,
        seed: true,
        plugin: claudePresent,
        daemon: true,
        autoAdr: false,
      };
      prompter = createReadlinePrompter();
      const outcome = await runWizard(defaults, prompter);
      if (!outcome.proceed) {
        process.stderr.write("Aborted.\n");
        return 0;
      }
      // The wizard already confirmed; runOnboard must not prompt again (opts.yes is true).
      opts = outcome.opts;
    } else {
      // --yes (interactive or not): defaults + explicit flags, non-interactive. The
      // non-interactive-without-yes case already returned above.
      const syncFolders = splitDirs(values.sync) ?? [projectDir];
      const seedRepos = splitDirs(values["seed-repo"]) ?? (seed ? syncFolders : []);
      opts = {
        brain: values.brain,
        yes: true,
        reseed: values.reseed,
        seed,
        plugin,
        daemon,
        build,
        scope,
        autoAdr: values["auto-adr"],
        remote: values.remote,
        syncFolders,
        seedRepos,
      };
    }

    const result = await runOnboard(cwd, opts, deps);

    process.stderr.write(
      `init: mode=${result.mode} brain=${result.brainDir} built=${result.built} ` +
        `staged=${result.staged} scopedFolders=${result.scopedFolders} ` +
        `mappedFolders=${result.mappedFolders} seededRepos=${result.seededRepos} ` +
        `scope=${result.scope} autoAdr=${result.autoAdr} ` +
        `remote=${result.remote} plugin=${result.plugin} daemon=${result.daemon} ` +
        `scopeConfig=${result.scopeConfigPath}\n`,
    );
    return 0;
  } finally {
    prompter?.close();
  }
}

/** True if the `<name>` executable resolves on the current PATH. */
function hasExecutable(name: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  const res = spawnSync(probe, [name], { stdio: "ignore" });
  return res.status === 0;
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntrypoint) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
      process.exitCode = 1;
    });
}
