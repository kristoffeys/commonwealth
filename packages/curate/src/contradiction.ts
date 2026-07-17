import {
  cosineSimilarity,
  embedProvider,
  isFeatureEnabled,
  listNotes,
  loadBrainConfig,
  loadVectors,
  type Embedder,
} from "@cmnwlth/core";

/**
 * A recorded decision the pending change looks like it contradicts (ADR-0033). Carries the note's
 * id (for the `[[id]]` citation), title, relative path, and the cosine similarity that surfaced it.
 */
export interface ContradictionMatch {
  id: string;
  title: string;
  /** Note path relative to the brain root (for the "Cited: <path>" line). */
  path: string;
  /** Cosine similarity of the change summary to this decision (0–1). */
  score: number;
}

/**
 * Outcome of {@link checkContradiction}. `enabled` is the `contradictionGuard` feature flag;
 * `provider` is whether an embeddings provider actually resolved (so the caller can distinguish
 * "feature off" from "on but no provider" — both are no-ops for the guard, but reported distinctly).
 * `match` is the nearest decision at/above threshold, or null when nothing crosses it.
 */
export interface ContradictionResult {
  enabled: boolean;
  provider: boolean;
  match: ContradictionMatch | null;
}

/**
 * Check whether `summary` (a compact description of a pending change) semantically contradicts a
 * recorded `decision` note (ADR-0033). This is the embeddings invocation path the PreToolUse guard
 * reuses rather than hand-rolling: it embeds `summary` with the SAME provider the curation gate
 * uses (ADR-0021) and nearest-neighbors it against the stored `decision` vectors (cosine), exactly
 * as {@link computeNeighbors} does for consolidation — only filtered to decisions and ranked to the
 * single top hit at/above the conservative threshold.
 *
 * Gating (all conservative, precision-over-recall):
 *  - the `contradictionGuard` flag must be ON (default off) → else `{ enabled: false }`, no work;
 *  - an embeddings provider must resolve and canon must have vectors → else `{ provider: false }`;
 *  - only NON-superseded `decision` notes are compared (never memory/work-state);
 *  - a hit is returned only when cosine ≥ `threshold` (config `contradictionGuard.threshold`,
 *    overridable via `opts.threshold` for the hook / tests).
 *
 * The `embedder` is injectable for tests (`null` forces "no provider"); in production it is resolved
 * from the brain config only when semantic vectors are actually available. Errors propagate to the
 * caller, which fails OPEN (the guard treats any failure as "no contradiction").
 */
export async function checkContradiction(
  brainDir: string,
  summary: string,
  opts: { threshold?: number; embedder?: Embedder | null } = {},
): Promise<ContradictionResult> {
  const enabled = await isFeatureEnabled(brainDir, "contradictionGuard");
  if (!enabled) return { enabled: false, provider: false, match: null };

  const config = await loadBrainConfig(brainDir);
  const threshold = opts.threshold ?? config.contradictionGuard.threshold;

  // No provider configured → the guard is a silent no-op (same discipline as the semantic gates).
  if (config.embeddings.provider === "none" && opts.embedder === undefined) {
    return { enabled: true, provider: false, match: null };
  }

  const trimmed = summary.trim();
  if (trimmed.length === 0) return { enabled: true, provider: true, match: null };

  // Resolving the provider may throw (e.g. the local model package isn't installed) — that is a
  // "no resolvable provider" no-op, not an error the guard should surface. Catch → provider:false.
  let embedder: Embedder | null;
  try {
    embedder = opts.embedder !== undefined ? opts.embedder : await embedProvider(config.embeddings);
  } catch {
    return { enabled: true, provider: false, match: null };
  }
  if (!embedder) return { enabled: true, provider: false, match: null };

  const vectors = await loadVectors(brainDir);
  if (vectors.size === 0) return { enabled: true, provider: true, match: null };

  // Decision notes only (ADR-0033) — never memory/work-state — and never a superseded decision (the
  // reasoning it carried has already been replaced, so it must not gate new work).
  const decisions = (await listNotes(brainDir)).filter(
    (n) => n.frontmatter.kind === "decision" && n.frontmatter.status !== "superseded",
  );
  if (decisions.length === 0) return { enabled: true, provider: true, match: null };

  const queryVec = (await embedder.embed([trimmed]))[0];
  if (!queryVec || queryVec.length === 0) return { enabled: true, provider: true, match: null };

  let best: ContradictionMatch | null = null;
  for (const note of decisions) {
    const vec = vectors.get(note.frontmatter.id);
    if (!vec) continue;
    const score = cosineSimilarity(queryVec, vec);
    if (score >= threshold && (best === null || score > best.score)) {
      best = { id: note.frontmatter.id, title: note.frontmatter.title, path: note.path, score };
    }
  }

  return { enabled: true, provider: true, match: best };
}
