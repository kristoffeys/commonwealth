import { type NoteKind } from "./schema.js";

export interface SearchOptions {
  kind?: NoteKind;
  /** Max results (default 20). */
  limit?: number;
}

export interface SearchResult {
  id: string;
  kind: NoteKind;
  title: string;
  path: string;
  /** Highlighted excerpt around the match. */
  snippet: string;
  /** Relevance score (higher = better). */
  score: number;
}

/**
 * (Re)build the derived SQLite FTS5 index from the markdown notes under `brainDir`.
 * The index lives at `index/commons.db`, is gitignored, and is fully disposable —
 * it can always be rebuilt from the files. See ADR-0005. Returns the count indexed.
 */
export async function buildIndex(_brainDir: string): Promise<{ indexed: number }> {
  throw new Error("not implemented: buildIndex");
}

/** Lexical (FTS5) search over title, body, tags, and frontmatter. */
export async function search(
  _brainDir: string,
  _query: string,
  _opts?: SearchOptions,
): Promise<SearchResult[]> {
  throw new Error("not implemented: search");
}

/**
 * Regenerate derived, never-hand-merged artifacts from the note set: the `COMMONS.md`
 * router (links to active work-state + recent decisions) and per-folder `INDEX.md`.
 * Idempotent — output is a pure function of the files (ADR-0003).
 */
export async function regenerateDerived(_brainDir: string): Promise<void> {
  throw new Error("not implemented: regenerateDerived");
}
