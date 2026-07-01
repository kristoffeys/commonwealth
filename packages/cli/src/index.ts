import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { defaultOnboardDeps } from "./deps.js";
import { defaultBrainDir, findRepoRoot } from "./init.js";
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

/** Print `commonwealth` usage to stderr. */
function printUsage(): void {
  process.stderr.write(
    [
      "commonwealth — git-backed markdown team-brain",
      "",
      "Usage:",
      "  commonwealth init [--brain <dir>] [--yes] [--reseed] [--auto-adr] [--remote <url>]",
      "                    [--sync <dir,dir,...>] [--seed-repo <dir,dir,...>]",
      "                    [--no-scope] [--no-seed] [--no-mcp] [--no-daemon] [--no-build]",
      "",
      "`init` is a single idempotent command: it builds the workspace (if needed), creates or",
      "joins the brain, syncs one or more folders into it (allowlist + brain marker), seeds it",
      "from one or more repos, registers the MCP server, and starts the sync daemon. Run in a",
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
      "  --no-mcp        Skip registering the MCP server with the claude CLI",
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

  if (command !== "init") {
    process.stderr.write(`Unknown command: ${command}\n`);
    printUsage();
    return 2;
  }

  if (rest.includes("--help") || rest.includes("-h")) {
    printUsage();
    return 0;
  }

  // parseArgs has no native negation; consume --no-* flags first and derive the gates.
  const negations = ["--no-scope", "--no-seed", "--no-mcp", "--no-daemon", "--no-build"];
  const scope = !rest.includes("--no-scope");
  const seed = !rest.includes("--no-seed");
  const mcp = !rest.includes("--no-mcp");
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
  const repoRoot = findRepoRoot(cwd);
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
    if (isInteractive() && !values.yes) {
      // Interactive terminal, no --yes: run the wizard.
      const defaults: WizardDefaults = {
        brain: defaultBrainDir(repoRoot),
        repoRoot,
        scope: true,
        seed: true,
        mcp: claudePresent,
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
    } else if (!values.yes) {
      // Non-interactive and no --yes: never hang on stdin, do nothing.
      process.stderr.write("Non-interactive: re-run in a terminal or pass --yes.\n");
      return 0;
    } else {
      // --yes: defaults + explicit flags, non-interactive.
      const syncFolders = splitDirs(values.sync) ?? [repoRoot];
      const seedRepos = splitDirs(values["seed-repo"]) ?? (seed ? syncFolders : []);
      opts = {
        brain: values.brain,
        yes: true,
        reseed: values.reseed,
        seed,
        mcp,
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
        `seededRepos=${result.seededRepos} scope=${result.scope} autoAdr=${result.autoAdr} ` +
        `remote=${result.remote} mcp=${result.mcp} daemon=${result.daemon} ` +
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
