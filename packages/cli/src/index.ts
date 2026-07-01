import { parseArgs } from "node:util";
import { defaultOnboardDeps } from "./deps.js";
import { runOnboard, type OnboardOptions } from "./onboard.js";

export { runInit, findRepoRoot, defaultBrainDir } from "./init.js";
export type { InitOptions, InitDeps, InitResult, InitBySource } from "./init.js";
export { defaultInitDeps, defaultOnboardDeps } from "./deps.js";
export { runOnboard } from "./onboard.js";
export type { OnboardOptions, OnboardDeps, OnboardResult } from "./onboard.js";

/** Print `commonwealth` usage to stderr. */
function printUsage(): void {
  process.stderr.write(
    [
      "commonwealth — git-backed markdown team-brain",
      "",
      "Usage:",
      "  commonwealth init [--brain <dir>] [--yes] [--reseed]",
      "                    [--no-seed] [--no-mcp] [--no-daemon] [--no-build]",
      "",
      "`init` is a single idempotent command: it builds the workspace (if needed), creates or",
      "joins the brain and seeds it, registers the MCP server, and starts the sync daemon.",
      "",
      "Options:",
      "  --brain <dir>   Create/use the brain at <dir> (default: ~/.commonwealth/brains/<project>)",
      "  --yes           Run non-interactively; skip the plan confirmation and seed prompt",
      "  --reseed        Re-seed even if this project already resolves to a brain",
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
  const seed = !rest.includes("--no-seed");
  const mcp = !rest.includes("--no-mcp");
  const daemon = !rest.includes("--no-daemon");
  const build = !rest.includes("--no-build");
  const positional = rest.filter(
    (a) => a !== "--no-seed" && a !== "--no-mcp" && a !== "--no-daemon" && a !== "--no-build",
  );

  let values: { brain?: string; yes?: boolean; reseed?: boolean };
  try {
    ({ values } = parseArgs({
      args: positional,
      options: {
        brain: { type: "string" },
        yes: { type: "boolean", default: false },
        reseed: { type: "boolean", default: false },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    printUsage();
    return 2;
  }

  const opts: OnboardOptions = {
    brain: values.brain,
    yes: values.yes,
    reseed: values.reseed,
    seed,
    mcp,
    daemon,
    build,
  };
  const deps = defaultOnboardDeps({ curateEntry: process.env.COMMONWEALTH_CURATE_BIN });
  const result = await runOnboard(process.cwd(), opts, deps);

  process.stderr.write(
    `init: mode=${result.mode} brain=${result.brainDir} built=${result.built} ` +
      `staged=${result.staged} mcp=${result.mcp} daemon=${result.daemon}\n`,
  );
  return 0;
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
