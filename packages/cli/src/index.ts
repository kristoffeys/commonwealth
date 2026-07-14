import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { defaultAddDeps, runAdd } from "./add.js";
import { cmdOrgBrain } from "./org-brain.js";
import { cmdRegistry } from "./registry.js";
import { cmdService } from "./service.js";
import {
  cliVersion,
  defaultUpdateDeps,
  defaultUpdateNoticeDeps,
  maybeNotifyUpdate,
  runUpdate,
} from "./update.js";
import { cmdConfig, cmdReseed, delegateCurate, delegateSync } from "./commands.js";
import { defaultOnboardDeps } from "./deps.js";
import { defaultAskEnv, formatAsk, runAsk } from "./ask.js";
import { defaultDemoEnv, runDemo } from "./demo.js";
import { defaultDoctorEnv, diagnose, formatDoctorText } from "./doctor.js";
import { defaultEmitEnv, formatEmitResult, runEmit } from "./emit.js";
import { defaultVerifyRestoreEnv, formatVerifyRestore, runVerifyRestore } from "./verify.js";
import {
  defaultClaudeSettingsPath,
  defaultStatuslineEnv,
  installStatusLine,
  runStatusline,
  uninstallStatusLine,
} from "./statusline.js";
import { defaultBrainDir } from "./init.js";
import {
  parseAgentTarget,
  runOnboard,
  runWizard,
  type OnboardOptions,
  type WizardDefaults,
} from "./onboard.js";
import { createReadlinePrompter, isInteractive, type Prompter } from "./prompt.js";

export { runInit, findRepoRoot, defaultBrainDir } from "./init.js";
export type { InitOptions, InitDeps, InitResult, InitBySource } from "./init.js";
export { defaultInitDeps, defaultOnboardDeps } from "./deps.js";
export { parseAgentTarget, runOnboard, runWizard } from "./onboard.js";
export type {
  AgentTarget,
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
export { runVerifyRestore, defaultVerifyRestoreEnv, formatVerifyRestore } from "./verify.js";
export type { VerifyRestoreReport, VerifyRestoreEnv } from "./verify.js";
export { runEmit, defaultEmitEnv, formatEmitResult, upsertSentinelBlock } from "./emit.js";
export type { EmitResult, EmitEnv } from "./emit.js";
export { runDemo, defaultDemoEnv } from "./demo.js";
export type { DemoResult, DemoEnv } from "./demo.js";
export { runAsk, defaultAskEnv, formatAsk } from "./ask.js";
export type { AskEnv } from "./ask.js";
export { runAdd, defaultAddDeps } from "./add.js";
export type { AddOptions, AddDeps } from "./add.js";
export { runOrgBrain, defaultOrgBrainDeps, parseOrgBrainArgs, cmdOrgBrain } from "./org-brain.js";
export {
  runRegistry,
  defaultRegistryDeps,
  parseRegistryArgs,
  parseMatcher,
  cmdRegistry,
} from "./registry.js";
export {
  runService,
  defaultServiceDeps,
  parseServiceArgs,
  launchdPlist,
  systemdUnit,
  schtasksCreateArgs,
  restart as restartService,
  type ServiceDeps,
  type ServiceOptions,
  type ServicePlatform,
} from "./service.js";
export type { OrgBrainOptions, OrgBrainDeps } from "./org-brain.js";
export {
  cliVersion,
  isNewer,
  fetchLatestVersion,
  detectInstallKind,
  runUpdate,
  defaultUpdateDeps,
  maybeNotifyUpdate,
  defaultUpdateCachePath,
  defaultUpdateNoticeDeps,
  CLI_PACKAGE,
} from "./update.js";
export type { UpdateDeps, UpdateNoticeDeps, InstallKind } from "./update.js";

/** Print `commonwealth` usage to stderr. */
function printUsage(): void {
  process.stderr.write(
    [
      "commonwealth — git-backed markdown team-brain",
      "",
      "Usage:",
      "  commonwealth demo                              60-second throwaway sandbox brain (no setup)",
      "  commonwealth init      [flags]                 onboard: build, create/join brain, plugin, daemon",
      "  commonwealth add       [<folder>...] [--brain <dir>] [--remote <url>]",
      "                                                 wire folder(s) to an existing brain (allowlist +",
      "                                                 routing rule + brains/ symlink) in one go",
      "  commonwealth org-brain <set <dir> [--remote <url>] | show>   designate/show the org-brain (graduation target)",
      "  commonwealth reseed    [<repo>...] [--all]     mine repo(s) into the mapped brain and capture",
      "  commonwealth config    <list | get <k> | set <k> <v>>   read/set the brain's shared config",
      "  commonwealth status                            review queue + sync-daemon state",
      "  commonwealth doctor    [--fix] [--json]        diagnose the install/sync chain; --fix restarts a dead daemon",
      "  commonwealth verify-restore [--from-remote] [--json]   clone + prove full disaster recovery (CI gate)",
      "  commonwealth emit      [--commit]              write brain context for Cursor/Copilot/Codex into this repo",
      "  commonwealth health                            freshness/trust rollup for the brain",
      "  commonwealth map                               brain-at-a-glance: per-kind counts + contributors",
      "  commonwealth statusline  [install|uninstall]   Claude Code status line (brain · freshness · pending)",
      "  commonwealth consolidate  [--dry-run]          supersede near-duplicate canon notes",
      "  commonwealth graduate  [--suggest] [--dry-run]  promote knowledge recurring across ≥2 brains to the org-brain",
      "  commonwealth sync      <start | stop | once>   control/run the sync daemon",
      "  commonwealth pending                           list notes awaiting review",
      "  commonwealth promote   <id...> | --all         approve staged notes into canon",
      "  commonwealth reject    <id...>                 discard staged notes",
      "  commonwealth registry  <show | route | allow | deny | remove | default>  brain-resolution rules",
      "  commonwealth service   <install | uninstall | status | restart>  run sync as a background service",
      "  commonwealth scope     <show | allow <p> | deny <p> | check>   per-user capture scope",
      "  commonwealth recall    <query>                 search the brain",
      "  commonwealth ask       <question>              cited retrieval for a question (agent synthesizes)",
      "  commonwealth update                            update the CLI + refresh the Claude Code plugin",
      "  commonwealth --version                         print the installed CLI version",
      "",
      "All commands resolve the brain from the registry for the current directory — no --dir needed.",
      "",
      "init flags: [--brain <dir>] [--yes] [--reseed] [--auto-adr] [--remote <url>]",
      "            [--sync <dir,dir,...>] [--seed-repo <dir,dir,...>]",
      "            [--agent <claude|codex|both>]",
      "            [--no-scope] [--no-seed] [--no-plugin] [--no-daemon] [--no-build]",
      "",
      "`init` is a single idempotent command: it builds the workspace (if needed), creates or",
      "joins the brain, syncs one or more folders into it (allowlist + a global routing rule",
      "with a ~/.commonwealth/brains/<name> symlink), seeds it from one or more repos, installs",
      "the Commonwealth plugin for the selected agent(s), and starts the sync daemon. Run in a",
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
      "  --agent <target>        Install for claude, codex, or both (default: claude)",
      "  --no-scope             Skip adding folders to the capture allowlist",
      "  --no-seed       Create the brain but skip gathering/staging seed candidates",
      "  --no-plugin     Skip installing the Commonwealth plugin",
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
 * `parseArgs` has no native boolean negation, so `--no-seed`/`--no-plugin`/`--no-daemon`/`--no-build`
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

  // Version is a stdout data contract (scripts do `commonwealth --version`), like git/node.
  if (command === "--version" || command === "-v" || command === "version") {
    process.stdout.write(`${cliVersion()}\n`);
    return 0;
  }

  // Unified subcommand surface (#93). `reseed`/`config` compose core+seed; the rest delegate to
  // the registry-aware curate/sync binaries (inheriting cwd, so they hit the mapped brain).
  switch (command) {
    case "demo":
      return cmdDemo(rest);
    case "init":
      return cmdInit(rest);
    case "add":
      return cmdAdd(rest);
    case "org-brain":
      return cmdOrgBrain(rest);
    case "registry":
      return cmdRegistry(rest);
    case "service":
      return cmdService(rest);
    case "update":
      return runUpdate(defaultUpdateDeps());
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
    case "verify-restore":
      return cmdVerifyRestore(rest);
    case "emit":
      return cmdEmit(rest);
    case "sync": {
      const sub = rest[0] === "once" ? "sync" : (rest[0] ?? "status");
      return delegateSync([sub, ...rest.slice(1)]);
    }
    case "health":
      return delegateCurate(["health"]);
    case "map":
      return delegateCurate(["map"]);
    case "statusline":
      return cmdStatusline(rest);
    case "consolidate":
      return delegateCurate(["consolidate", ...rest]);
    case "graduate":
      return delegateCurate(["graduate", ...rest]);
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
    case "ask":
      return cmdAsk(rest);
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

/**
 * `commonwealth verify-restore [--from-remote] [--json]` — clone the brain into a throwaway temp
 * dir and prove full disaster recovery (schema, unique ids, supersede chains, no secrets,
 * byte-identical derived files), printing an RPO line. `--from-remote` clones the origin remote
 * (the real off-site proof) rather than the local repo. Exit 0 when recovery is verified, 1
 * otherwise — a green/red CI gate.
 */
async function cmdVerifyRestore(rest: string[]): Promise<number> {
  const json = rest.includes("--json");
  const fromRemote = rest.includes("--from-remote");
  let report;
  try {
    report = await runVerifyRestore({ fromRemote }, defaultVerifyRestoreEnv(process.cwd()));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stderr.write(formatVerifyRestore(report));
  return report.ok ? 0 : 1;
}

/**
 * `commonwealth ask "<question>"` — cited retrieval for a question (ADR-0020). Outside an agent
 * there's no synthesizer, so the CLI prints the notes that answer it (each with id/path) and says
 * synthesis happens in an agent; it never fabricates prose. Exit 1 when no brain resolves.
 */
async function cmdAsk(rest: string[]): Promise<number> {
  const question = rest.join(" ").trim();
  if (question.length === 0) {
    process.stderr.write('usage: commonwealth ask "<question>"\n');
    return 2;
  }
  try {
    const result = await runAsk(question, defaultAskEnv(process.cwd()));
    process.stderr.write(formatAsk(result));
    return 0;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
}

/**
 * `commonwealth demo [--keep]` — scaffold a throwaway fictional-team brain and replay a few
 * scripted `recall` questions, so a first-time user sees retrieval work in under a minute with no
 * setup. `--keep` leaves the sandbox brain on disk and prints its path. Output goes to stderr;
 * there is no stdout data contract.
 */
async function cmdDemo(rest: string[]): Promise<number> {
  const keep = rest.includes("--keep");
  await runDemo(defaultDemoEnv(keep, (line) => process.stderr.write(`${line}\n`)));
  return 0;
}

/**
 * `commonwealth emit [--commit]` — write the current project's team-brain slice into the derived
 * context files Cursor/Copilot/Codex read (`.cursor/rules/commonwealth.mdc`, `.github/instructions/
 * commonwealth.instructions.md`, and an `AGENTS.md` sentinel block). Wholly-owned files are
 * gitignored by default; `--commit` tracks them.
 */
async function cmdEmit(rest: string[]): Promise<number> {
  const commit = rest.includes("--commit");
  let result;
  try {
    result = await runEmit({ commit }, defaultEmitEnv(process.cwd()));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
  process.stderr.write(formatEmitResult(result));
  return 0;
}

/** Read all of stdin as UTF-8, or "" if there is none (statusline is invoked with a JSON blob). */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * `commonwealth statusline [install|uninstall]` (#197). With no subcommand it is the Claude Code
 * `statusLine` command: read the stdin JSON, resolve the brain for its cwd, and print the one-line
 * status (empty when no brain). `install`/`uninstall` wire the entry into `~/.claude/settings.json`
 * (a plugin can't register a statusLine itself). Rendering NEVER throws — a broken statusline must
 * not spam the session — so all errors degrade to empty output.
 */
async function cmdStatusline(rest: string[]): Promise<number> {
  const sub = rest[0];
  if (sub === "install" || sub === "uninstall") {
    const settingsPath = defaultClaudeSettingsPath();
    try {
      const result =
        sub === "install"
          ? await installStatusLine(settingsPath)
          : await uninstallStatusLine(settingsPath);
      const messages: Record<string, string> = {
        installed: `Added the Commonwealth status line to ${settingsPath}. Restart Claude Code to see it.`,
        already: `The Commonwealth status line is already configured in ${settingsPath}.`,
        conflict: `${settingsPath} already defines a different statusLine — leaving it untouched. To use Commonwealth's, set "statusLine.command" to "commonwealth statusline".`,
        removed: `Removed the Commonwealth status line from ${settingsPath}.`,
        absent: `No statusLine was configured in ${settingsPath}.`,
      };
      process.stderr.write(`${messages[result]}\n`);
      return result === "conflict" ? 1 : 0;
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      return 1;
    }
  }

  // Render path: parse the statusline stdin JSON for the cwd, then emit the one-liner. Any failure
  // (bad JSON, resolver error) degrades to empty output rather than a visible error.
  try {
    let cwd = process.cwd();
    const raw = await readStdin();
    if (raw.trim().length > 0) {
      const input = JSON.parse(raw);
      cwd = input?.cwd || input?.workspace?.current_dir || cwd;
    }
    const line = await runStatusline(defaultStatuslineEnv(cwd));
    if (line.length > 0) process.stdout.write(`${line}\n`);
  } catch {
    // Emit nothing — a statusline must never surface an error into the session chrome.
  }
  return 0;
}

/**
 * `commonwealth add [<folder>...] [--brain <dir>] [--remote <url>]` — wire folders to an
 * existing brain without the full `init` orchestrator (#157): per folder, capture-allowlist +
 * global routing rule + `~/.commonwealth/brains/<name>` symlink. With no folders, wires the
 * cwd; with no `--brain`, uses the brain the cwd already resolves to.
 */
async function cmdAdd(rest: string[]): Promise<number> {
  let values: { brain?: string; remote?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      options: { brain: { type: "string" }, remote: { type: "string" } },
      allowPositionals: true,
    }));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    printUsage();
    return 2;
  }

  return runAdd(
    {
      folders: positionals,
      ...(values.brain !== undefined ? { brain: values.brain } : {}),
      ...(values.remote !== undefined ? { remote: values.remote } : {}),
      cwd: process.cwd(),
    },
    defaultAddDeps(),
  );
}

/** `commonwealth init` — the onboarding orchestrator (build → create/seed/join → plugin → daemon). */
async function cmdInit(rest: string[]): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    printUsage();
    return 0;
  }

  // parseArgs has no native negation; consume --no-* flags first and derive the gates.
  const negations = ["--no-scope", "--no-seed", "--no-plugin", "--no-daemon", "--no-build"];
  const scope = !rest.includes("--no-scope");
  const seed = !rest.includes("--no-seed");
  const plugin = !rest.includes("--no-plugin");
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
    agent?: string;
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
        agent: { type: "string" },
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
  const agent = parseAgentTarget(values.agent);
  if (agent === null) {
    process.stderr.write("Invalid --agent value. Expected claude, codex, or both.\n");
    return 2;
  }

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
  const codexPresent = hasExecutable("codex");
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
        plugin:
          agent === "claude"
            ? claudePresent
            : agent === "codex"
              ? codexPresent
              : claudePresent || codexPresent,
        agent,
        daemon: true,
        autoAdr: true,
      };
      prompter = createReadlinePrompter();
      const outcome = await runWizard(defaults, prompter);
      if (!outcome.proceed) {
        process.stderr.write("Aborted.\n");
        return 0;
      }
      // The wizard already confirmed; runOnboard must not prompt again (opts.yes is true).
      opts = outcome.opts;
      opts.agent = agent;
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
        agent,
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
        `remote=${result.remote} agent=${agent} plugin=${result.plugin} context=${result.context} ` +
        `daemon=${result.daemon} ` +
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

// npm installs bins as symlinks while the ESM loader resolves import.meta.url to the
// realpath, so argv[1] must be realpath'd before comparing or the guard never matches.
const isEntrypoint = (() => {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  const argv = process.argv.slice(2);
  run(argv)
    .then(async (code) => {
      // Passive update notice (#161), AFTER the command so it can't delay or reorder output.
      // Pointless right after `update` or a bare version print; every other gate (TTY, CI,
      // opt-out env, daily cache) lives in maybeNotifyUpdate itself.
      if (!["update", "--version", "-v", "version"].includes(argv[0] ?? "")) {
        await maybeNotifyUpdate(defaultUpdateNoticeDeps());
      }
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
      process.exitCode = 1;
    });
}
