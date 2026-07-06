import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gatherCandidates } from "./seed.js";

export { mineGitHistory, type MineGitHistoryOptions } from "./git-miner.js";
export { importConfigs } from "./config-importer.js";
export {
  gatherCandidates,
  type GatherOptions,
  type GatherResult,
  type GatherBySource,
} from "./seed.js";

/** How many sample titles the `preview` subcommand prints. */
const PREVIEW_SAMPLE_LIMIT = 10;

/** Print human-readable usage to stderr. */
function printUsage(): void {
  process.stderr.write(
    [
      "commonwealth-seed — produce cold-start seed candidates from a repo",
      "",
      "Usage:",
      "  commonwealth-seed preview [--repo <dir>]   Summarize candidates for eyeballing",
      "  commonwealth-seed gather  [--repo <dir>]   Emit candidates as JSON (pipe to curate)",
      "",
      "Pipe into curate to stage them:",
      "  commonwealth-seed gather | commonwealth-curate capture",
      "",
    ].join("\n"),
  );
}

/**
 * Run the `commonwealth-seed` CLI. `preview` prints a human summary; `gather` prints the
 * candidates as a JSON array (and nothing else) on stdout for piping into
 * `commonwealth-curate capture`. Returns the process exit code.
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

  if (command !== "preview" && command !== "gather") {
    process.stderr.write(`Unknown command: ${command}\n`);
    printUsage();
    return 2;
  }

  let repo: string;
  try {
    const { values } = parseArgs({
      args: rest,
      options: {
        repo: { type: "string" },
      },
      allowPositionals: false,
    });
    repo = values.repo ?? process.cwd();
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    printUsage();
    return 2;
  }

  const { candidates, bySource } = await gatherCandidates(repo);

  if (command === "gather") {
    process.stdout.write(JSON.stringify(candidates) + "\n");
    return 0;
  }

  // preview
  const lines: string[] = [];
  lines.push(`${candidates.length} candidate${candidates.length === 1 ? "" : "s"}`);
  lines.push(`adr: ${bySource.adr}, git: ${bySource.git}, config: ${bySource.config}`);
  if (candidates.length > 0) {
    lines.push("");
    lines.push("Sample titles:");
    for (const note of candidates.slice(0, PREVIEW_SAMPLE_LIMIT)) {
      lines.push(`  - [${note.kind}] ${note.title}`);
    }
    if (candidates.length > PREVIEW_SAMPLE_LIMIT) {
      lines.push(`  … and ${candidates.length - PREVIEW_SAMPLE_LIMIT} more`);
    }
  }
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
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
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
      process.exitCode = 1;
    });
}
