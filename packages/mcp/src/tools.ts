import {
  buildIndex,
  listNotes,
  readNote,
  regenerateDerived,
  resolveProjectSource,
  search,
  writeNote,
  type Frontmatter,
  type Note,
  type NoteKind,
  type SearchResult,
} from "@commonwealth/core";

/**
 * Pure handler layer for the Commonwealth MCP server.
 *
 * Each function takes an explicit `brainDir` plus typed args and returns a plain JS
 * result object — no MCP framing. `server.ts` adapts these into MCP tools, and the
 * tests exercise them directly. All logic lives here; the server is a thin shell.
 *
 * Markdown files are the source of truth: every read/write goes through `@commonwealth/core`,
 * never a parallel store (ADR-0003, ADR-0005).
 */

/** Arguments for {@link searchNotes}. */
export interface SearchNotesArgs {
  query: string;
  kind?: NoteKind;
  limit?: number;
}

/**
 * Lexical search across the brain's notes, optionally scoped to one `kind` and capped
 * at `limit` results. Delegates to `core.search` (FTS5 over title/body/tags).
 */
export async function searchNotes(
  brainDir: string,
  { query, kind, limit }: SearchNotesArgs,
): Promise<SearchResult[]> {
  return search(brainDir, query, { kind, limit });
}

/** Arguments for {@link readNoteTool}. */
export interface ReadNoteArgs {
  /** Repo-relative path, e.g. `memory/2026-07-01-foo-a1b2.md`. */
  path: string;
}

/** A single note, flattened for return over the wire. */
export interface ReadNoteResult {
  path: string;
  frontmatter: Frontmatter;
  body: string;
}

/**
 * Read one note by its repo-relative path. Delegates to `core.readNote`, which throws
 * if the file is missing or its frontmatter fails schema validation.
 */
export async function readNoteTool(
  brainDir: string,
  { path }: ReadNoteArgs,
): Promise<ReadNoteResult> {
  const note = await readNote(brainDir, path);
  return { path: note.path, frontmatter: note.frontmatter, body: note.body };
}

/** Arguments for {@link remember}. */
export interface RememberArgs {
  kind: NoteKind;
  title: string;
  body: string;
  tags?: string[];
  author?: string;
}

/** Identifier + location of a newly written note. */
export interface RememberResult {
  id: string;
  path: string;
}

/**
 * Persist a new atomic note and refresh derived state so it is immediately findable.
 *
 * M1 writes straight to canon: `core.writeNote` creates the file, then we rebuild the
 * derived index (`core.buildIndex`) and regenerate routers/indexes
 * (`core.regenerateDerived`) so a subsequent {@link searchNotes} sees the new note.
 *
 * M3 will route this through `memory/_staging/` + the curation gate instead of writing
 * canon directly (docs/01-architecture.md §3 — capture → curate → commit).
 */
export async function remember(
  brainDir: string,
  { kind, title, body, tags, author }: RememberArgs,
): Promise<RememberResult> {
  // Attribute the note to the project the MCP is running in (ADR-0015), so it files under
  // <project>/<kind>/ like hook-captured notes. Best-effort: unresolved → unattributed.
  const source = (await resolveProjectSource(process.cwd())) ?? undefined;
  const note = await writeNote(brainDir, { kind, title, body, tags, author, source });
  // Refresh disposable derived artifacts so the write is visible to reads/search.
  await buildIndex(brainDir);
  await regenerateDerived(brainDir);
  return { id: note.frontmatter.id, path: note.path };
}

/**
 * List active work-state notes (everything whose `status` is not `done`). Delegates to
 * `core.listNotes(brainDir, "work-state")`.
 */
export async function listWorkState(brainDir: string): Promise<Note[]> {
  const notes = await listNotes(brainDir, "work-state");
  return notes.filter(
    (n) => n.frontmatter.kind === "work-state" && n.frontmatter.status !== "done",
  );
}

/** Arguments for {@link whoIs}. */
export interface WhoIsArgs {
  query: string;
}

/**
 * Look up people by name, id, or tag. Case-insensitive substring match over the
 * `person` note set. Returns every match (empty array if none).
 */
export async function whoIs(brainDir: string, { query }: WhoIsArgs): Promise<Note[]> {
  const q = query.trim().toLowerCase();
  const people = await listNotes(brainDir, "person");
  if (q === "") return people;
  return people.filter((n) => {
    const fm = n.frontmatter;
    if (fm.kind !== "person") return false;
    const haystacks = [fm.name, fm.title, fm.id, ...fm.tags];
    return haystacks.some((h) => h.toLowerCase().includes(q));
  });
}
