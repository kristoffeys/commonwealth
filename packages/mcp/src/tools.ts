import {
  askBrain,
  buildIndex,
  listNotes,
  manifestStamp,
  readNote,
  regenerateDerived,
  resolveContributorIdentity,
  resolveProjectManifest,
  resolveProjectSource,
  search,
  type AskResult,
  type Frontmatter,
  type Note,
  type NoteKind,
  type SearchResult,
} from "@cmnwlth/core";
import { captureCandidates } from "@cmnwlth/curate";

/**
 * Pure handler layer for the Commonwealth MCP server.
 *
 * Each function takes an explicit `brainDir` plus typed args and returns a plain JS
 * result object — no MCP framing. `server.ts` adapts these into MCP tools, and the
 * tests exercise them directly. All logic lives here; the server is a thin shell.
 *
 * Markdown files are the source of truth: every read/write goes through `@cmnwlth/core`,
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

/** Arguments for {@link askBrainTool}. */
export interface AskArgs {
  question: string;
  limit?: number;
}

/**
 * "Ask the brain" retrieval (ADR-0020): returns citation-anchored context for a question. Does
 * NOT synthesize — the calling agent answers from these notes and cites them. Thin wrapper over
 * `core.askBrain`.
 */
export async function askBrainTool(
  brainDir: string,
  { question, limit }: AskArgs,
): Promise<AskResult> {
  return askBrain(brainDir, question, { limit });
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
  /** @deprecated Responsibility is bound to trusted local identity; this value is ignored. */
  author?: string;
}

/** Outcome of a {@link remember}: promoted to canon, staged for review, or gate-rejected. */
export interface RememberResult {
  /** `promoted` = in canon; `staged` = in the review queue; `rejected` = a gate declined it. */
  status: "promoted" | "staged" | "rejected";
  /** The note id, when it was accepted (promoted or staged). */
  id?: string;
  /** Canonical path when promoted, staging path when staged. */
  path?: string;
  /** Why a gate declined the note (e.g. `contains-secret`, `duplicate`), when rejected. */
  reason?: string;
  /** Stable contributor-person id responsible for the write. */
  personId?: string;
}

/**
 * Record a note through the SAME curation path as automatic capture (#82): the secret gate,
 * relevance/dedup gate, and the per-brain `autoPromote` decision all apply. Previously this
 * wrote straight to canon via `writeNote`, bypassing every gate — so an MCP client could plant a
 * secret or a duplicate directly into shared canon. Now it delegates to `captureCandidates`,
 * which stages the note and (unless `autoPromote` is off) approves it into canon.
 *
 * On promotion we refresh the disposable derived artifacts so a subsequent {@link searchNotes}
 * sees the note immediately (staged notes intentionally are NOT indexed until approved).
 */
export async function remember(
  brainDir: string,
  { kind, title, body, tags }: RememberArgs,
): Promise<RememberResult> {
  // Attribute the note to the project the MCP is running in (ADR-0015), so it files under
  // <project>/<kind>/ like hook-captured notes. Best-effort: unresolved → unattributed.
  const source = (await resolveProjectSource(process.cwd())) ?? undefined;
  // Declared engagement identity (ADR-0031): a `.commonwealth/project.json` manifest at/above the
  // MCP process cwd stamps `project` + a `customer:<slug>` tag; absent → identity resolves from the
  // alias map / source-as-singleton at read time.
  const manifest = await resolveProjectManifest(process.cwd());
  const stamp = manifest ? manifestStamp(manifest) : null;
  const noteTags = tags ?? [];
  const stampedTags =
    stamp?.tag && !noteTags.includes(stamp.tag) ? [...noteTags, stamp.tag] : noteTags;
  const contributor = await resolveContributorIdentity(process.cwd());
  if (!contributor) return { status: "rejected", reason: "missing-contributor-identity" };
  const result = await captureCandidates(
    brainDir,
    [
      {
        kind,
        title,
        body,
        tags: stampedTags,
        ...(source ? { source } : {}),
        ...(stamp ? { project: stamp.project } : {}),
      },
    ],
    undefined,
    { contributor },
  );

  const rejected = result.rejected[0];
  if (rejected) {
    return {
      status: "rejected",
      reason: rejected.reason,
      ...(result.contributorPersonId ? { personId: result.contributorPersonId } : {}),
    };
  }

  const note = result.staged[0];
  if (!note) {
    return {
      status: "rejected",
      reason: "not-staged",
      ...(result.contributorPersonId ? { personId: result.contributorPersonId } : {}),
    };
  }

  if (result.promoted.length > 0) {
    // autoPromote landed it in canon — refresh derived so reads/search see it now.
    await buildIndex(brainDir);
    await regenerateDerived(brainDir);
    return {
      status: "promoted",
      id: note.frontmatter.id,
      path: result.promoted[0],
      ...(result.contributorPersonId ? { personId: result.contributorPersonId } : {}),
    };
  }
  return {
    status: "staged",
    id: note.frontmatter.id,
    path: note.path,
    ...(result.contributorPersonId ? { personId: result.contributorPersonId } : {}),
  };
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
