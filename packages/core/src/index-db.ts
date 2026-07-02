import { promises as fs } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { listNotes } from "./notes.js";
import { type Note, type NoteKind } from "./schema.js";

export interface SearchOptions {
  kind?: NoteKind;
  /** Restrict to notes from one originating project (frontmatter `source`; ADR-0015). */
  source?: string;
  /** Max results (default 20). */
  limit?: number;
}

export interface SearchResult {
  id: string;
  kind: NoteKind;
  title: string;
  path: string;
  /** Originating project, when the note carries one. */
  source?: string;
  /** Highlighted excerpt around the match. */
  snippet: string;
  /** Relevance score (higher = better). */
  score: number;
}

/** Repo-relative location of the derived, disposable SQLite index. */
const INDEX_DIR = "index";
const DB_FILE = "commonwealth.db";

/** Absolute path to the SQLite index db for a brain. */
function dbPath(brainDir: string): string {
  return path.join(brainDir, INDEX_DIR, DB_FILE);
}

/** Row shape mirrored into the FTS5 table. */
interface IndexRow {
  id: string;
  kind: NoteKind;
  title: string;
  tags: string;
  body: string;
  path: string;
  source: string;
}

function toRow(note: Note): IndexRow {
  return {
    id: note.frontmatter.id,
    kind: note.frontmatter.kind,
    title: note.frontmatter.title,
    tags: note.frontmatter.tags.join(" "),
    body: note.body,
    path: note.path,
    source: note.frontmatter.source ?? "",
  };
}

/**
 * (Re)build the derived SQLite FTS5 index from the markdown notes under `brainDir`.
 * The index lives at `index/commonwealth.db`, is gitignored, and is fully disposable —
 * it can always be rebuilt from the files. See ADR-0005.
 *
 * Performs a FULL rebuild each call (DROP + CREATE) so the result is a pure function
 * of the note set and running it twice is idempotent. Returns the count indexed.
 */
export async function buildIndex(brainDir: string): Promise<{ indexed: number }> {
  await fs.mkdir(path.join(brainDir, INDEX_DIR), { recursive: true });
  const notes = await listNotes(brainDir);

  const db = new Database(dbPath(brainDir));
  try {
    // Full rebuild + read-only queries: the default rollback journal leaves no
    // persistent sidecar files (unlike WAL's -wal/-shm), keeping index/ clean.
    db.exec("DROP TABLE IF EXISTS notes_fts;");
    // `path` is UNINDEXED: stored/returned but not part of the full-text match.
    db.exec(
      "CREATE VIRTUAL TABLE notes_fts USING fts5(" +
        "id, kind, title, tags, body, path UNINDEXED, source UNINDEXED" +
        ");",
    );

    const insert = db.prepare(
      "INSERT INTO notes_fts (id, kind, title, tags, body, path, source) " +
        "VALUES (@id, @kind, @title, @tags, @body, @path, @source);",
    );
    const insertAll = db.transaction((rows: IndexRow[]) => {
      for (const row of rows) insert.run(row);
    });
    insertAll(notes.map(toRow));

    return { indexed: notes.length };
  } finally {
    db.close();
  }
}

/**
 * Escape a user query for FTS5 by wrapping each whitespace-separated token as a
 * quoted string, so punctuation in the query can't be parsed as FTS operators.
 * Empty queries yield "" (which matches nothing).
 */
function toMatchQuery(query: string): string {
  return query
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ""))
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`)
    .join(" ");
}

/**
 * Lexical (FTS5) search over title, body, and tags. Builds the index on first use if it
 * is missing, but does NOT detect subsequent note additions/edits/removals — the index
 * refreshes only when {@link buildIndex} is called. Callers that need fresh results after
 * writes should rebuild first.
 */
export async function search(
  brainDir: string,
  query: string,
  opts?: SearchOptions,
): Promise<SearchResult[]> {
  // Build the index on demand if it has never been created.
  try {
    await fs.access(dbPath(brainDir));
  } catch {
    await buildIndex(brainDir);
  }

  const match = toMatchQuery(query);
  if (match === "") return [];

  const limit = opts?.limit ?? 20;
  const db = new Database(dbPath(brainDir), { readonly: true });
  try {
    // snippet(): excerpt of the body column (index 4) with matches marked by [ ].
    // bm25() returns a negative-ish score where lower = more relevant, so we negate
    // it to expose a positive score where higher = better.
    const params: (string | number)[] = [match];
    let sql =
      "SELECT id, kind, title, path, source, " +
      "snippet(notes_fts, 4, '[', ']', '…', 12) AS snippet, " +
      "-bm25(notes_fts) AS score " +
      "FROM notes_fts WHERE notes_fts MATCH ?";
    if (opts?.kind) {
      sql += " AND kind = ?";
      params.push(opts.kind);
    }
    if (opts?.source) {
      sql += " AND source = ?";
      params.push(opts.source);
    }
    sql += " ORDER BY bm25(notes_fts) LIMIT ?";
    params.push(limit);

    const rows = db.prepare(sql).all(...params) as Array<{
      id: string;
      kind: NoteKind;
      title: string;
      path: string;
      source: string;
      snippet: string;
      score: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      path: r.path,
      ...(r.source ? { source: r.source } : {}),
      snippet: r.snippet,
      score: r.score,
    }));
  } finally {
    db.close();
  }
}

/** Notes whose `status` counts as still-active work (i.e. not `done`). */
function isActiveWorkState(note: Note): boolean {
  return note.frontmatter.kind === "work-state" && note.frontmatter.status !== "done";
}

/** Stable, deterministic sort by id so derived output is byte-identical across runs. */
function byId(a: Note, b: Note): number {
  return a.frontmatter.id < b.frontmatter.id ? -1 : a.frontmatter.id > b.frontmatter.id ? 1 : 0;
}

/** Sort decisions by created date desc, tie-broken by id for determinism. */
function byCreatedDesc(a: Note, b: Note): number {
  if (a.frontmatter.created !== b.frontmatter.created) {
    return a.frontmatter.created < b.frontmatter.created ? 1 : -1;
  }
  return byId(a, b);
}

/** Display label for a note's originating project; unattributed notes group under a sentinel. */
const UNATTRIBUTED = "(unattributed)";
function sourceOf(note: Note): string {
  return note.frontmatter.source && note.frontmatter.source.length > 0
    ? note.frontmatter.source
    : UNATTRIBUTED;
}

/** Sort project labels alphabetically, with the unattributed bucket always last. */
function bySourceLabel(a: string, b: string): number {
  if (a === UNATTRIBUTED) return b === UNATTRIBUTED ? 0 : 1;
  if (b === UNATTRIBUTED) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The generated router, grouped by originating project (ADR-0015): a section per project with
 * its active work-state and recent decisions, so a shared brain reads project-by-project.
 */
function commonwealthMarkdown(notes: Note[]): string {
  const lines: string[] = [];
  lines.push("# Commonwealth");
  lines.push("");
  lines.push("> Generated router. Do not edit by hand — regenerated from the note set (ADR-0003).");
  lines.push("");

  const bySource = new Map<string, Note[]>();
  for (const n of notes) {
    const key = sourceOf(n);
    (bySource.get(key) ?? bySource.set(key, []).get(key)!).push(n);
  }
  const sources = [...bySource.keys()].sort(bySourceLabel);
  if (sources.length === 0) {
    lines.push("_No notes yet._");
    lines.push("");
    return lines.join("\n");
  }

  for (const source of sources) {
    const group = bySource.get(source)!;
    const active = group.filter(isActiveWorkState).sort(byId);
    const decisions = group.filter((n) => n.frontmatter.kind === "decision").sort(byCreatedDesc);
    lines.push(`## ${source}`);
    lines.push("");
    lines.push("**Active work-state**");
    if (active.length === 0) {
      lines.push("- _None._");
    } else {
      for (const n of active) {
        const status = n.frontmatter.kind === "work-state" ? n.frontmatter.status : "";
        lines.push(`- [${n.frontmatter.title}](${n.path}) — ${status}`);
      }
    }
    lines.push("");
    lines.push("**Recent decisions**");
    if (decisions.length === 0) {
      lines.push("- _None._");
    } else {
      for (const n of decisions) {
        lines.push(`- [${n.frontmatter.title}](${n.path}) — ${n.frontmatter.created}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Generated INDEX.md for one note-containing directory: its notes, linked by filename. */
function indexMarkdown(dirRel: string, notes: Note[]): string {
  const sorted = [...notes].sort(byId);
  const lines: string[] = [];
  lines.push(`# ${dirRel}`);
  lines.push("");
  lines.push("> Generated index. Do not edit by hand — regenerated from the note set.");
  lines.push("");
  if (sorted.length === 0) {
    lines.push("_None._");
  } else {
    for (const n of sorted) {
      // INDEX.md lives in the same folder as the notes, so link by filename only.
      lines.push(`- [${n.frontmatter.title}](${path.posix.basename(n.path)})`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Regenerate derived, never-hand-merged artifacts from the note set: the `COMMONWEALTH.md`
 * router (grouped by project, ADR-0015) and an `INDEX.md` in every directory that holds notes
 * (`<kind>/` and `<project>/<kind>/`). Idempotent — output is a pure function of the files
 * (ADR-0003), so running twice yields byte-identical files.
 */
export async function regenerateDerived(brainDir: string): Promise<void> {
  const notes = await listNotes(brainDir);

  await fs.writeFile(path.join(brainDir, "COMMONWEALTH.md"), commonwealthMarkdown(notes), "utf8");

  // One INDEX.md per directory that actually contains notes — works for both the flat kind
  // root and per-project subtrees without assuming a fixed set of folders.
  const byDir = new Map<string, Note[]>();
  for (const n of notes) {
    const dir = path.posix.dirname(n.path.split(path.sep).join("/"));
    (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(n);
  }
  for (const [dir, group] of byDir) {
    const abs = path.join(brainDir, dir);
    await fs.mkdir(abs, { recursive: true });
    await fs.writeFile(path.join(abs, "INDEX.md"), indexMarkdown(dir, group), "utf8");
  }
}
