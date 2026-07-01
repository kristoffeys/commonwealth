import { parseArgs } from "node:util";
import { defaultInitDeps } from "./deps.js";
import { runInit, type InitOptions } from "./init.js";

export { runInit, findRepoRoot, defaultBrainDir } from "./init.js";
export type { InitOptions, InitDeps, InitResult, InitBySource } from "./init.js";
export { defaultInitDeps } from "./deps.js";

/** Print `commons` usage to stderr. */
function printUsage(): void {
  process.stderr.write(
    [
      "commons — git-backed markdown team-brain",
      "",
      "Usage:",
      "  commons init [--brain <dir>] [--yes] [--reseed]",
      "",
      "Options:",
      "  --brain <dir>   Create/use the brain at <dir> (default: ~/.commons/brains/<project>)",
      "  --yes           Seed without the confirmation prompt",
      "  --reseed        Re-seed even if this project already resolves to a brain",
      "",
    ].join("\n"),
  );
}

/**
 * `commons` CLI entry. Parses argv, dispatches `init`, prints a one-line summary to
 * stderr, and resolves the exit code. Diagnostics go to stderr; there is no stdout data
 * contract for `init`. Unknown commands and `--help` print usage.
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

  let values: { brain?: string; yes?: boolean; reseed?: boolean };
  try {
    ({ values } = parseArgs({
      args: rest,
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

  const opts: InitOptions = { brain: values.brain, yes: values.yes, reseed: values.reseed };
  const deps = defaultInitDeps({ assumeYes: values.yes });
  const result = await runInit(process.cwd(), opts, deps);

  process.stderr.write(
    `init: mode=${result.mode} brain=${result.brainDir} staged=${result.staged} gathered=${result.gathered}\n`,
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
