import {
  cosineSimilarity,
  embedProvider,
  isFeatureEnabled,
  listNotes,
  loadBrainConfig,
  loadVectors,
  type Embedder,
  type NewNoteInput,
  type Note,
  type NoteKind,
} from "@cmnwlth/core";
import { textSimilarity } from "./curate.js";
import type { AnnotatedCandidate } from "./verdict.js";

/** Default number of nearest-canon neighbors returned per candidate. */
const DEFAULT_K = 2;

/** Max characters of a neighbor's body carried in the compact excerpt the classifier sees. */
const EXCERPT_LIMIT = 320;

/** A nearest-canon note for one candidate, with a compact excerpt for the classifier's context. */
export interface CandidateNeighbor {
  id: string;
  kind: NoteKind;
  title: string;
  /** Compact body excerpt (bounded), so the batched classifier prompt stays small. */
  excerpt: string;
  /** Similarity to the candidate (cosine when vectors are present, else lexical Jaccard); 0–1. */
  score: number;
}

/** A candidate annotated with its nearest-canon neighbors (input to the classifier). */
export type CandidateWithNeighbors = AnnotatedCandidate & { neighbors: CandidateNeighbor[] };

/** Output of {@link computeNeighbors}: whether the LLM curator is enabled, and the annotated set. */
export interface NeighborsResult {
  /** The `llmCurator` feature flag (ADR-0030). When false the hook skips the classifier entirely. */
  enabled: boolean;
  candidates: CandidateWithNeighbors[];
}

/** Combined title + body text used for similarity, matching the curate gate's comparison text. */
function candidateText(input: NewNoteInput): string {
  return `${input.title} ${input.body}`;
}

function noteText(note: Note): string {
  return `${note.frontmatter.title} ${note.body}`;
}

function excerpt(body: string): string {
  const trimmed = body.trim().replace(/\s+/g, " ");
  return trimmed.length <= EXCERPT_LIMIT ? trimmed : `${trimmed.slice(0, EXCERPT_LIMIT)}…`;
}

function toNeighbor(note: Note, score: number): CandidateNeighbor {
  return {
    id: note.frontmatter.id,
    kind: note.frontmatter.kind,
    title: note.frontmatter.title,
    excerpt: excerpt(note.body),
    score,
  };
}

/** Top-`k` canon notes for one candidate by a precomputed score list, filtered to score > 0. */
function topK(scored: Array<{ note: Note; score: number }>, k: number): CandidateNeighbor[] {
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((s) => toNeighbor(s.note, s.score));
}

/**
 * Compute the top-`k` nearest CANON notes for each candidate — the deterministic, offline context
 * the LLM consolidation classifier (ADR-0030) reasons over. It is intentionally **model-free** for
 * ranking: it reuses the same similarity machinery the curation gate does — stored embedding
 * vectors when a provider resolves and canon has been indexed (cosine), else the lexical token-set
 * Jaccard fallback. Embedding is best-effort: any provider/embed failure degrades to lexical, never
 * aborting. Gated by the `llmCurator` flag: when off, returns `enabled: false` and empty neighbors
 * so the hook does no classifier work.
 *
 * The `embedder` is injectable for tests (`null` forces lexical); in production it is resolved from
 * the brain config only when semantic vectors are actually available.
 */
export async function computeNeighbors(
  brainDir: string,
  candidates: AnnotatedCandidate[],
  opts: { k?: number; embedder?: Embedder | null } = {},
): Promise<NeighborsResult> {
  const k = opts.k ?? DEFAULT_K;

  const enabled = await isFeatureEnabled(brainDir, "llmCurator");
  if (!enabled) {
    return { enabled: false, candidates: candidates.map((c) => ({ ...c, neighbors: [] })) };
  }

  const canon = await listNotes(brainDir);
  if (canon.length === 0 || candidates.length === 0) {
    return { enabled: true, candidates: candidates.map((c) => ({ ...c, neighbors: [] })) };
  }

  // Resolve the embedder + canon vectors, guarded exactly like the curate gate: an absent provider,
  // an unindexed brain, or an embed failure all fall back to lexical Jaccard rather than failing.
  let vectors: Map<string, Float32Array> | null = null;
  let candidateVectors: Float32Array[] | null = null;
  const config = await loadBrainConfig(brainDir);
  if (config.embeddings.provider !== "none") {
    try {
      const embedder =
        opts.embedder !== undefined ? opts.embedder : await embedProvider(config.embeddings);
      if (embedder) {
        const loaded = await loadVectors(brainDir);
        if (loaded.size > 0) {
          candidateVectors = await embedder.embed(candidates.map(candidateText));
          vectors = loaded;
        }
      }
    } catch (err) {
      console.error(
        `[commonwealth-curate] neighbors: falling back to lexical similarity ` +
          `(${err instanceof Error ? err.message : String(err)})`,
      );
      vectors = null;
      candidateVectors = null;
    }
  }

  const annotated: CandidateWithNeighbors[] = candidates.map((candidate, i) => {
    let scored: Array<{ note: Note; score: number }>;
    const cvec = candidateVectors?.[i];
    if (vectors && cvec) {
      scored = canon.map((note) => {
        const nvec = vectors!.get(note.frontmatter.id);
        return { note, score: nvec ? cosineSimilarity(cvec, nvec) : 0 };
      });
    } else {
      const text = candidateText(candidate);
      scored = canon.map((note) => ({ note, score: textSimilarity(text, noteText(note)) }));
    }
    return { ...candidate, neighbors: topK(scored, k) };
  });

  return { enabled: true, candidates: annotated };
}
