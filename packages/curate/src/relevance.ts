import { listNotes, readNote, search, type Note } from "@commons/core";

/** How to select relevant context for injection (ADR-0007 #12). */
export interface RelevanceQuery {
  /** Free-text query; when present, drives a lexical search. */
  query?: string;
  /** Max notes to return (default 10). */
  limit?: number;
}

const DEFAULT_LIMIT = 10;

/** Stable, deterministic sort by id so injected context is reproducible across runs. */
function byId(a: Note, b: Note): number {
  return a.frontmatter.id < b.frontmatter.id ? -1 : a.frontmatter.id > b.frontmatter.id ? 1 : 0;
}

/** Sort by created date desc, tie-broken by id for determinism. */
function byCreatedDesc(a: Note, b: Note): number {
  if (a.frontmatter.created !== b.frontmatter.created) {
    return a.frontmatter.created < b.frontmatter.created ? 1 : -1;
  }
  return byId(a, b);
}

/**
 * Select the notes most relevant to inject into a session (ADR-0007 #12). With a query,
 * this is a lexical search (each hit re-read into a full {@link Note}). Without one, it
 * returns the current working context: active (not-`done`) work-state plus recent
 * decisions, deterministically ordered and capped at `limit`.
 */
export async function selectRelevant(brainDir: string, q: RelevanceQuery = {}): Promise<Note[]> {
  const limit = q.limit ?? DEFAULT_LIMIT;

  if (q.query !== undefined && q.query.trim().length > 0) {
    const hits = await search(brainDir, q.query, { limit });
    const notes: Note[] = [];
    for (const hit of hits) {
      notes.push(await readNote(brainDir, hit.path));
    }
    return notes;
  }

  const workStates = await listNotes(brainDir, "work-state");
  const active = workStates
    .filter((n) => n.frontmatter.kind === "work-state" && n.frontmatter.status !== "done")
    .sort(byId);

  const decisions = (await listNotes(brainDir, "decision")).sort(byCreatedDesc);

  return [...active, ...decisions].slice(0, limit);
}
