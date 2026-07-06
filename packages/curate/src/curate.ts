import {
  cosineSimilarity,
  embedProvider,
  hasSecrets,
  listNotes,
  loadBrainConfig,
  loadVectors,
  scanOptions,
  type Embedder,
  type NewNoteInput,
  type Note,
} from "@cmnwlth/core";
import { listStaged, stageNote } from "./staging.js";

/** Minimum trimmed body length for a candidate to clear the relevance gate. */
const MIN_BODY_LENGTH = 15;

/** Token-set Jaccard threshold at/above which a candidate is treated as a duplicate. */
const DUPLICATE_THRESHOLD = 0.8;

/** Outcome of assessing a single candidate against the existing note set. */
export interface Assessment {
  accept: boolean;
  reason: string;
  /** Id of the existing note a rejected candidate duplicates, when reason is "duplicate". */
  duplicateOf?: string;
}

/**
 * Pluggable curation seam (ADR-0007). A curator decides whether a proposed note is worth
 * staging, given the notes that already exist (canon + already-staged). The default is
 * deterministic; an LLM/embedding-backed curator can be swapped in without reworking the
 * staging/review mechanics.
 */
export interface Curator {
  assess(candidate: NewNoteInput, existing: Note[]): Assessment;
}

/** Lowercase, strip punctuation, and split into a set of word tokens. */
function tokenSet(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .trim();
  const tokens = normalized.split(/\s+/).filter((t) => t.length > 0);
  return new Set(tokens);
}

/** Jaccard similarity of two token sets (|A∩B| / |A∪B|); 0 when both are empty. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Token-set Jaccard similarity of two texts (0–1). Shared with the consolidation pass (#29). */
export function textSimilarity(a: string, b: string): number {
  return jaccard(tokenSet(a), tokenSet(b));
}

/** Combined title + body text used for similarity comparison. */
function candidateText(input: NewNoteInput): string {
  return `${input.title} ${input.body}`;
}

/**
 * All candidate text a secret could hide in — title, body, tags, and every kind-specific
 * field value — flattened for the secret gate so its coverage matches the pre-commit scrub,
 * which scans the whole serialized note (#99). `fields` values may be strings/arrays/objects,
 * so JSON-encode them to reach nested secrets.
 */
function candidateSecretScanText(input: NewNoteInput): string {
  const parts = [input.title, input.body, ...(input.tags ?? [])];
  if (input.author) parts.push(input.author);
  if (input.source) parts.push(input.source);
  if (input.fields && Object.keys(input.fields).length > 0)
    parts.push(JSON.stringify(input.fields));
  return parts.join("\n");
}

/** Combined title + body text of an existing note. */
function noteText(note: Note): string {
  return `${note.frontmatter.title} ${note.body}`;
}

/**
 * Deterministic default curator (ADR-0007): a relevance gate plus token-similarity
 * dedupe. No external calls; fully offline. Semantic dedupe/verification are deferred to
 * an embedding-backed curator behind this same seam.
 */
export const defaultCurator: Curator = {
  assess(candidate: NewNoteInput, existing: Note[]): Assessment {
    // (a) Relevance gate: reject empty titles and trivially short bodies.
    if (candidate.title.trim().length === 0 || candidate.body.trim().length < MIN_BODY_LENGTH) {
      return { accept: false, reason: "too-thin" };
    }

    // (b) Dedupe: token-set Jaccard vs each existing note; reject the nearest near-dupe.
    const candidateTokens = tokenSet(candidateText(candidate));
    let bestScore = 0;
    let bestId: string | undefined;
    for (const note of existing) {
      const score = jaccard(candidateTokens, tokenSet(noteText(note)));
      if (score > bestScore) {
        bestScore = score;
        bestId = note.frontmatter.id;
      }
    }
    if (bestScore >= DUPLICATE_THRESHOLD && bestId !== undefined) {
      return { accept: false, reason: "duplicate", duplicateOf: bestId };
    }

    return { accept: true, reason: "accepted" };
  },
};

/** A candidate that the curator declined to stage, with the reason it was dropped. */
export interface RejectedCandidate {
  candidate: NewNoteInput;
  reason: string;
  duplicateOf?: string;
}

/** Result of a curation run: what got staged and what was rejected (and why). */
export interface CurateResult {
  staged: Note[];
  rejected: RejectedCandidate[];
}

/**
 * A semantic near-duplicate found for a candidate: the canon note it matched and the cosine
 * score, or `undefined` when no canon vector reaches the threshold.
 */
interface SemanticHit {
  id: string;
  score: number;
}

/**
 * Find the nearest canon note to `candidate` by cosine over stored embeddings, treating a score
 * ≥ `threshold` as a near-duplicate (ADR-0021). Embedding the candidate is best-effort: a model
 * failure logs and returns `undefined` (fall back to lexical), never aborts curation.
 */
async function semanticDuplicate(
  candidate: NewNoteInput,
  embedder: Embedder,
  canonVectors: Map<string, Float32Array>,
  threshold: number,
): Promise<SemanticHit | undefined> {
  let vec: Float32Array | undefined;
  try {
    [vec] = await embedder.embed([candidateText(candidate)]);
  } catch (err) {
    console.error(
      `[commonwealth-curate] semantic dedup skipped for a candidate (embed failed): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
  if (!vec) return undefined;

  let bestId: string | undefined;
  let bestScore = 0;
  for (const [id, cvec] of canonVectors) {
    const score = cosineSimilarity(vec, cvec);
    if (score > bestScore) {
      bestScore = score;
      bestId = id;
    }
  }
  return bestScore >= threshold && bestId !== undefined
    ? { id: bestId, score: bestScore }
    : undefined;
}

/**
 * Run candidates through the curator and stage the accepted ones (ADR-0007). The existing
 * set is seeded from canon (`listNotes`) plus already-staged notes, and each accepted
 * candidate is folded back into it as we go — so within-batch near-duplicates are also
 * caught (only the first of a set is staged).
 *
 * When the `semanticDedup` flag is on (ADR-0021), an embeddings check runs *alongside* the
 * lexical gate: a candidate whose embedding is a near-duplicate (cosine ≥ threshold) of an
 * existing CANON note is rejected even when the Jaccard gate would have missed the paraphrase.
 * The lexical gate is unchanged and still runs first; semantic dedup only adds rejections. The
 * `embedder` is injectable for tests; in production it is resolved from the brain config, and any
 * resolution/embed failure degrades gracefully to lexical-only.
 */
export async function curate(
  brainDir: string,
  candidates: NewNoteInput[],
  curator: Curator = defaultCurator,
  embedder?: Embedder | null,
): Promise<CurateResult> {
  const canon = await listNotes(brainDir);
  const staged = await listStaged(brainDir);
  const existing: Note[] = [...canon, ...staged];

  const result: CurateResult = { staged: [], rejected: [] };

  const config = await loadBrainConfig(brainDir);
  // auto-ADR gate (ADR-0009 #33): decisions only flow through when the team has opted in.
  const autoAdr = Boolean(config.features.autoAdr);
  // Secret-scanner tuning from the brain config (#46): entropy detection + allowlist, off by
  // default. Loaded once here and applied to every candidate's secret gate.
  const secretOpts = scanOptions(config);

  // Semantic dedup setup (ADR-0021), only when the flag is on. Resolve the embedder (unless one
  // is injected) and load canon vectors once. Resolution is guarded: an absent/misconfigured
  // provider disables semantic dedup for this run rather than failing the whole capture.
  let semanticEmbedder: Embedder | null = null;
  let canonVectors: Map<string, Float32Array> | null = null;
  if (config.features.semanticDedup) {
    try {
      semanticEmbedder = embedder !== undefined ? embedder : await embedProvider(config.embeddings);
    } catch (err) {
      console.error(
        `[commonwealth-curate] semantic dedup disabled: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      semanticEmbedder = null;
    }
    if (semanticEmbedder) canonVectors = await loadVectors(brainDir);
  }

  for (const candidate of candidates) {
    // Secret gate (#16): never stage a candidate carrying a credential. Reject before
    // assess/dedupe so a secret-bearing note is neither staged nor folded into `existing`.
    // Scan the WHOLE candidate — title, body, tags AND kind-specific fields — not just
    // title+body: the pre-commit scrub scans the entire serialized note, so a secret in a tag
    // or field would otherwise pass this gate, promote to canon, then be silently withheld by
    // the scrub on every sync forever (#99).
    if (hasSecrets(candidateSecretScanText(candidate), secretOpts)) {
      result.rejected.push({ candidate, reason: "contains-secret" });
      continue;
    }

    // Gate decisions before the normal assess/dedupe path; a dropped decision is not staged
    // and does not count against dedupe (it never enters `existing`).
    if (candidate.kind === "decision" && !autoAdr) {
      result.rejected.push({ candidate, reason: "auto-adr-disabled" });
      continue;
    }

    const assessment = curator.assess(candidate, existing);
    if (!assessment.accept) {
      result.rejected.push({
        candidate,
        reason: assessment.reason,
        ...(assessment.duplicateOf !== undefined ? { duplicateOf: assessment.duplicateOf } : {}),
      });
      continue;
    }

    // Semantic dedup (ADR-0021): the lexical gate accepted, but the embedding may still be a
    // near-duplicate of an existing canon note phrased differently. Compare only against stored
    // CANON vectors (in-batch/staged dupes are already caught lexically above); an empty vector
    // set (no embedder-backed build yet) simply no-ops.
    if (semanticEmbedder && canonVectors && canonVectors.size > 0) {
      const hit = await semanticDuplicate(
        candidate,
        semanticEmbedder,
        canonVectors,
        config.embeddings.threshold,
      );
      if (hit) {
        result.rejected.push({ candidate, reason: "duplicate", duplicateOf: hit.id });
        continue;
      }
    }

    // Stage individually-guarded: a single malformed candidate (e.g. an invalid kind or a
    // field the schema rejects) is dropped on its own rather than aborting the whole batch and
    // discarding every other valid note in the session (#88).
    try {
      const note = await stageNote(brainDir, candidate);
      result.staged.push(note);
      // Fold into the existing set so later batch entries dedupe against it too.
      existing.push(note);
    } catch (err) {
      result.rejected.push({
        candidate,
        reason: `invalid: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return result;
}
