import { promises as fs } from "node:fs";
import { parseArgs } from "node:util";
import { NOTE_KINDS, type NewNoteInput, type NoteKind } from "@commons/core";
import { captureCandidates } from "./capture.js";
import { formatContext } from "./context.js";
import { curate } from "./curate.js";
import { selectRelevant } from "./relevance.js";
import { approve, approveAll, listPending, reject } from "./review.js";
import { addAllow, addDeny, isInScope, loadUserConfig } from "./scope.js";

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
      "  commons-curate context [--dir <brain>] [--cwd <dir>] [--query <q>] [--limit <n>]",
      "  commons-curate capture [--dir <brain>] [--cwd <dir>] [--from <json-file>]",
      "  commons-curate scope show",
      "  commons-curate scope check [--cwd <dir>]",
      "  commons-curate scope allow <path>",
      "  commons-curate scope deny <path>",
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
 * `context` — emit relevant team-brain context for the session's cwd (what a SessionStart
 * hook injects). Out-of-scope cwds print nothing and exit 0; diagnostics go to stderr.
 */
async function cmdContext(dir: string, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: "string" },
      cwd: { type: "string" },
      query: { type: "string" },
      limit: { type: "string" },
    },
    allowPositionals: false,
  });

  const cwd = typeof values.cwd === "string" ? values.cwd : process.cwd();
  const config = await loadUserConfig();
  if (!isInScope(cwd, config)) {
    console.error(`[commons-curate] ${cwd} is out of scope; injecting nothing`);
    return;
  }

  const limit = values.limit !== undefined ? Number.parseInt(values.limit, 10) : undefined;
  const notes = await selectRelevant(dir, {
    ...(typeof values.query === "string" ? { query: values.query } : {}),
    ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
  });

  const rendered = formatContext(notes);
  if (rendered.length > 0) console.log(rendered);
}

/** Read and validate a candidate array (`NewNoteInput[]`) from a JSON string. */
function parseCandidates(raw: string): NewNoteInput[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("capture expects a JSON array of candidate notes");
  }
  return parsed as NewNoteInput[];
}

/** Read all of STDIN as a UTF-8 string. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * `capture` — stage session-proposed candidate notes, but only when the session's cwd is
 * in scope. Out-of-scope cwds (personal projects) are silently skipped (exit 0, no stdout).
 * Candidates come from `--from <json-file>` or STDIN.
 */
async function cmdCapture(dir: string, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: "string" },
      cwd: { type: "string" },
      from: { type: "string" },
    },
    allowPositionals: false,
  });

  const cwd = typeof values.cwd === "string" ? values.cwd : process.cwd();
  const config = await loadUserConfig();
  if (!isInScope(cwd, config)) {
    console.error(`[commons-curate] ${cwd} is out of scope; capturing nothing`);
    return;
  }

  const raw =
    typeof values.from === "string" ? await fs.readFile(values.from, "utf8") : await readStdin();
  const candidates = parseCandidates(raw);

  const result = await captureCandidates(dir, candidates);
  for (const note of result.staged) {
    console.log(`${note.frontmatter.id}  [${note.frontmatter.kind}]  ${note.frontmatter.title}`);
  }
  for (const r of result.rejected) {
    const extra = r.duplicateOf ? ` (of ${r.duplicateOf})` : "";
    console.error(`[commons-curate] rejected: ${r.reason}${extra}`);
  }
}

/** `scope <show|check|allow|deny>` — inspect and edit the per-user scope filter. */
async function cmdScope(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "show": {
      const config = await loadUserConfig();
      console.log(JSON.stringify(config, null, 2));
      return;
    }
    case "check": {
      const { values } = parseArgs({
        args: rest,
        options: { cwd: { type: "string" } },
        allowPositionals: false,
      });
      const cwd = typeof values.cwd === "string" ? values.cwd : process.cwd();
      const config = await loadUserConfig();
      console.log(isInScope(cwd, config) ? "in-scope" : "out-of-scope");
      return;
    }
    case "allow": {
      const target = rest[0];
      if (!target) throw new Error("scope allow requires a <path>");
      await addAllow(target);
      console.error(`[commons-curate] allow += ${target}`);
      return;
    }
    case "deny": {
      const target = rest[0];
      if (!target) throw new Error("scope deny requires a <path>");
      await addDeny(target);
      console.error(`[commons-curate] deny += ${target}`);
      return;
    }
    default:
      throw new Error(`unknown scope subcommand "${sub ?? ""}"; expected show|check|allow|deny`);
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
    case "context":
      await cmdContext(dir, rest);
      break;
    case "capture":
      await cmdCapture(dir, rest);
      break;
    case "scope":
      await cmdScope(rest);
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
