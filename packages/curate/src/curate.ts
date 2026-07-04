import {
  hasSecrets,
  isFeatureEnabled,
  listNotes,
  loadBrainConfig,
  scanOptions,
  type NewNoteInput,
  type Note,
} from "@commonwealth/core";
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
 * Run candidates through the curator and stage the accepted ones (ADR-0007). The existing
 * set is seeded from canon (`listNotes`) plus already-staged notes, and each accepted
 * candidate is folded back into it as we go — so within-batch near-duplicates are also
 * caught (only the first of a set is staged).
 */
export async function curate(
  brainDir: string,
  candidates: NewNoteInput[],
  curator: Curator = defaultCurator,
): Promise<CurateResult> {
  const canon = await listNotes(brainDir);
  const staged = await listStaged(brainDir);
  const existing: Note[] = [...canon, ...staged];

  const result: CurateResult = { staged: [], rejected: [] };

  // auto-ADR gate (ADR-0009 #33): decisions only flow through when the team has opted in.
  const autoAdr = await isFeatureEnabled(brainDir, "autoAdr");
  // Secret-scanner tuning from the brain config (#46): entropy detection + allowlist, off by
  // default. Loaded once here and applied to every candidate's secret gate.
  const secretOpts = scanOptions(await loadBrainConfig(brainDir));

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
