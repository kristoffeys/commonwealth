import { listNotes, readNote, search, type Note, type SearchResult } from "@cmnwlth/core";

/** How to select relevant context for injection (ADR-0007 #12). */
export interface RelevanceQuery {
  /** Free-text query; when present, drives a lexical search. */
  query?: string;
  /** Max notes to return (default 10). */
  limit?: number;
}

const DEFAULT_LIMIT = 10;

/**
 * Strict-retrieval floor for per-prompt context INJECTION (#236). Injection is the first strict
 * adopter because noise costs most there — a vector-near-but-wrong note silently injected into every
 * session's context is worse than a missed one. `1` rejects pure semantic noise (a hit with zero
 * lexical/title/tag overlap with the query) while keeping every note that arrived lexically (incl.
 * the #209 OR-fallback) or shares a query keyword in its title/tags — so the #213 stopword-paraphrase
 * case, which arrives via the OR-fallback lexical list, still survives. Conservative on purpose.
 */
export const INJECTION_MIN_LEXICAL_SUPPORT = 1;

/** One injection hit: the search result (with optional diagnostics) plus its fully-read note. */
export interface RelevantHit {
  result: SearchResult;
  note: Note;
}

/**
 * Run the injection search for `query` and read each hit into a full {@link Note}. Shared by
 * {@link selectRelevant} (notes only) and {@link selectRelevantDiagnostics} (hits + provenance) so
 * both apply the SAME strict floor and options — the verbose view can never diverge from what is
 * actually injected. `diagnostics` toggles per-result provenance for the `recall --verbose` surface.
 */
async function injectionSearch(
  brainDir: string,
  query: string,
  limit: number,
  diagnostics: boolean,
): Promise<RelevantHit[]> {
  const results = await search(brainDir, query, {
    limit,
    minLexicalSupport: INJECTION_MIN_LEXICAL_SUPPORT,
    ...(diagnostics ? { diagnostics: true } : {}),
  });
  const hits: RelevantHit[] = [];
  for (const result of results) {
    hits.push({ result, note: await readNote(brainDir, result.path) });
  }
  return hits;
}

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
    const hits = await injectionSearch(brainDir, q.query, limit, false);
    return hits.map((h) => h.note);
  }

  const workStates = await listNotes(brainDir, "work-state");
  const active = workStates
    .filter((n) => n.frontmatter.kind === "work-state" && n.frontmatter.status !== "done")
    .sort(byId);

  const decisions = (await listNotes(brainDir, "decision")).sort(byCreatedDesc);

  return [...active, ...decisions].slice(0, limit);
}

/**
 * The query-branch of {@link selectRelevant}, but returning the search hits WITH per-result
 * diagnostics (#236) attached — backing `recall --verbose`. Same strict floor and options as the
 * injected selection, so the provenance the user sees describes exactly what injection would pick.
 */
export async function selectRelevantDiagnostics(
  brainDir: string,
  query: string,
  limit: number = DEFAULT_LIMIT,
): Promise<RelevantHit[]> {
  return injectionSearch(brainDir, query, limit, true);
}
