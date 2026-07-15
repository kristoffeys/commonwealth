import {
  attributeNoteInputs,
  ensureContributorPerson,
  isFeatureEnabled,
  type ContributorIdentity,
  type NewNoteInput,
} from "@cmnwlth/core";
import { curate, type CurateResult, type Curator } from "./curate.js";
import { approve, reject } from "./review.js";
import { reassignStagedContributor } from "./staging.js";

async function rollbackStagedAttribution(
  brainDir: string,
  staged: CurateResult["staged"],
  cause: unknown,
): Promise<never> {
  const cleanupErrors: unknown[] = [];
  for (const note of staged) {
    try {
      await reject(brainDir, note.frontmatter.id);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [cause, ...cleanupErrors],
      "contributor creation failed and staged attribution rollback was incomplete",
    );
  }
  throw cause;
}

/** Result of {@link captureCandidates}: the staging outcome plus any notes auto-promoted. */
export interface CaptureResult extends CurateResult {
  /** Canonical repo-relative paths of notes promoted straight to canon (autoPromote). */
  promoted: string[];
  /** Stable contributor-person id attached to this batch, when it was person-authored. */
  contributorPersonId?: string;
}

export interface CaptureOptions {
  /** Trusted local person responsible for these candidates; omitted for impersonal imports. */
  contributor?: ContributorIdentity;
}

/**
 * Capture agent-proposed notes (ADR-0007 #9). A SessionEnd/Stop hook calls this with the
 * candidates it extracted from a session; extracting them is the hook's job, not this
 * package's — here we gate, stage, and (by default) promote them.
 *
 * The candidates are first curated into `staging/` (dedup + validation gating). Then, unless
 * the brain has turned the `autoPromote` feature off, each freshly-staged note is approved
 * straight into canon (ADR-0014) — the gating still runs, only the *manual* review step is
 * skipped. With `autoPromote: false` the notes stay in the review queue for
 * `/commonwealth:promote`, and `promoted` is empty.
 */
export async function captureCandidates(
  brainDir: string,
  candidates: NewNoteInput[],
  curator?: Curator,
  options: CaptureOptions = {},
): Promise<CaptureResult> {
  const attribution = options.contributor
    ? await attributeNoteInputs(brainDir, candidates, options.contributor)
    : null;
  const inputs = attribution?.candidates ?? candidates;
  const result = await curate(brainDir, inputs, curator);
  let contributorPersonId: string | undefined;
  if (attribution && options.contributor && result.staged.length > 0) {
    try {
      const person = await ensureContributorPerson(brainDir, options.contributor);
      if (person.frontmatter.id !== attribution.personId) {
        for (let index = 0; index < result.staged.length; index += 1) {
          result.staged[index] = await reassignStagedContributor(
            brainDir,
            result.staged[index]!,
            attribution.personId,
            person.frontmatter.id,
          );
        }
      }
      contributorPersonId = person.frontmatter.id;
    } catch (error) {
      await rollbackStagedAttribution(brainDir, result.staged, error);
    }
  }
  const promoted: string[] = [];
  if (result.staged.length > 0 && (await isFeatureEnabled(brainDir, "autoPromote"))) {
    for (const note of result.staged) {
      promoted.push(await approve(brainDir, note.frontmatter.id));
    }
  }
  return {
    ...result,
    promoted,
    ...(contributorPersonId ? { contributorPersonId } : {}),
  };
}
