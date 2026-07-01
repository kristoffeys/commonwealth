import { parseArgs } from "node:util";
import { NOTE_KINDS, type NewNoteInput, type NoteKind } from "@commons/core";
import { curate } from "./curate.js";
import { approve, approveAll, listPending, reject } from "./review.js";

/**
 * Resolve the brain directory: an explicit `--dir`, else `$COMMONS_BRAIN_DIR`, else cwd.
 */
function resolveDir(explicit: string | undefined): string {
  return explicit ?? process.env.COMMONS_BRAIN_DIR ?? process.cwd();
}

/** Print usage to stderr. */
function usage(): void {
  console.error(
    [
      "commons-curate — curation + in-repo review queue",
      "",
      "Usage:",
      "  commons-curate list [--dir <brain>]",
      "  commons-curate approve <id...> [--dir <brain>]",
      "  commons-curate reject <id...> [--dir <brain>]",
      "  commons-curate approve-all [--dir <brain>]",
      "  commons-curate stage --kind <kind> --title <t> --body <b> [--tags a,b] [--dir <brain>]",
      "",
      `Kinds: ${NOTE_KINDS.join(", ")}`,
    ].join("\n"),
  );
}

/** Type guard: is a string one of the four note kinds? */
function isNoteKind(value: string): value is NoteKind {
  return (NOTE_KINDS as readonly string[]).includes(value);
}

async function cmdList(dir: string): Promise<void> {
  const pending = await listPending(dir);
  for (const note of pending) {
    console.log(`${note.frontmatter.id}  [${note.frontmatter.kind}]  ${note.frontmatter.title}`);
  }
}

async function cmdApprove(dir: string, ids: string[]): Promise<void> {
  if (ids.length === 0) throw new Error("approve requires at least one <id>");
  for (const id of ids) {
    const canonPath = await approve(dir, id);
    console.log(canonPath);
  }
}

async function cmdReject(dir: string, ids: string[]): Promise<void> {
  if (ids.length === 0) throw new Error("reject requires at least one <id>");
  for (const id of ids) {
    await reject(dir, id);
    console.error(`[commons-curate] rejected ${id}`);
  }
}

async function cmdApproveAll(dir: string): Promise<void> {
  const paths = await approveAll(dir);
  for (const p of paths) console.log(p);
  console.error(`[commons-curate] approved ${paths.length} note(s)`);
}

async function cmdStage(dir: string, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      kind: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      tags: { type: "string" },
      // Tolerated here (handled by the top-level parser) so `--dir` doesn't error.
      dir: { type: "string" },
    },
    allowPositionals: false,
  });

  const { kind, title, body, tags } = values;
  if (!kind || !title || !body) {
    throw new Error("stage requires --kind, --title and --body");
  }
  if (!isNoteKind(kind)) {
    throw new Error(`invalid --kind "${kind}"; expected one of: ${NOTE_KINDS.join(", ")}`);
  }

  const candidate: NewNoteInput = {
    kind,
    title,
    body,
    ...(tags
      ? {
          tags: tags
            .split(",")
            .map((t) => t.trim())
            .filter((t) => t.length > 0),
        }
      : {}),
  };

  const result = await curate(dir, [candidate]);
  for (const note of result.staged) {
    console.log(`${note.frontmatter.id}  [${note.frontmatter.kind}]  ${note.frontmatter.title}`);
  }
  for (const r of result.rejected) {
    const extra = r.duplicateOf ? ` (of ${r.duplicateOf})` : "";
    console.error(`[commons-curate] rejected: ${r.reason}${extra}`);
  }
}

/**
 * `commons-curate` CLI entry (ADR-0007). Diagnostics go to stderr; approved/staged paths
 * and ids go to stdout so they compose with other tools. NO shebang here — tsup's banner
 * supplies it; a source shebang would break the built binary.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [command, ...rest] = argv;

  // Peel off a shared `--dir` from the remaining args; the rest are command-specific.
  const { values, positionals } = parseArgs({
    args: rest,
    options: { dir: { type: "string" } },
    allowPositionals: true,
    // Leave unknown options (e.g. stage's --kind) for the subcommand parser.
    strict: false,
  });
  const dir = resolveDir(typeof values.dir === "string" ? values.dir : undefined);

  switch (command) {
    case "list":
      await cmdList(dir);
      break;
    case "approve":
      await cmdApprove(dir, positionals);
      break;
    case "reject":
      await cmdReject(dir, positionals);
      break;
    case "approve-all":
      await cmdApproveAll(dir);
      break;
    case "stage":
      // stage owns its own flags; re-parse the original rest (minus --dir handled above).
      await cmdStage(dir, rest);
      break;
    default:
      usage();
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((err: unknown) => {
  console.error("[commons-curate] error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
