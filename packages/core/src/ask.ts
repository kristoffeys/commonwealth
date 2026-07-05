import { search } from "./index-db.js";

/**
 * "Ask the brain" retrieval (ADR-0020, #108). Commonwealth does NOT synthesize the answer — the
 * host agent (Claude Code, via the MCP plugin) does. This layer's job is to return
 * citation-anchored, budget-bounded context the agent can answer from *faithfully*: every hit
 * carries its note id + repo-relative path, so a citation can only ever point at a real note (the
 * agent cannot fabricate provenance). A coverage signal lets the caller/agent decline gracefully
 * when the brain doesn't actually cover the question, instead of inventing an answer.
 *
 * Retrieval quality is whatever `search` provides (FTS5 today, embeddings later — #107); `ask` is
 * agnostic to it and improves for free when that lands.
 */

/** One citation-anchored hit: enough to cite and to decide whether to `read` the full note. */
export interface AskHit {
  /** Note id — the stable citation handle. */
  id: string;
  kind: string;
  /** Note title. */
  title: string;
  /** Repo-relative path (what `read` takes; resolves the citation to the real file). */
  path: string;
  /** Originating project (ADR-0015), when known. */
  source: string;
  /** A short, match-highlighted excerpt of the note body. */
  excerpt: string;
}

/** How well the brain covers the question — so the agent/CLI can decline instead of hallucinating. */
export interface AskCoverage {
  /** True when at least one note matched. */
  matched: boolean;
  /** Relevance of the top hit (higher = better); 0 when nothing matched. */
  topScore: number;
  /** Total notes that matched before the budget cap. */
  total: number;
}

/** The retrieval result an agent answers from. Deterministic; no model is called. */
export interface AskResult {
  question: string;
  hits: AskHit[];
  coverage: AskCoverage;
}

/** Options for {@link askBrain}. */
export interface AskOptions {
  /** Max hits to consider before the char budget (default 8). */
  limit?: number;
  /** Approximate character budget across all excerpts (~4 chars/token; default 4000). */
  maxChars?: number;
}

/**
 * Retrieve the citation-anchored context for `question`. Runs `search`, then fills hits up to
 * `limit` and a `maxChars` budget (the most relevant survive truncation). Returns an empty
 * `hits` + `matched: false` when nothing matches — never throws for "no answer".
 */
export async function askBrain(
  brainDir: string,
  question: string,
  opts: AskOptions = {},
): Promise<AskResult> {
  const limit = opts.limit ?? 8;
  const maxChars = opts.maxChars ?? 4000;
  const results = await search(brainDir, question, { limit });

  const hits: AskHit[] = [];
  let used = 0;
  for (const r of results) {
    const excerpt = (r.snippet ?? "").replace(/\s+/g, " ").trim();
    const size = r.title.length + r.path.length + excerpt.length;
    if (used + size > maxChars && hits.length > 0) break;
    hits.push({
      id: r.id,
      kind: r.kind,
      title: r.title,
      path: r.path,
      source: r.source ?? "",
      excerpt,
    });
    used += size;
  }

  return {
    question,
    hits,
    coverage: {
      matched: results.length > 0,
      topScore: results[0]?.score ?? 0,
      total: results.length,
    },
  };
}
