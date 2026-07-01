import { isFeatureEnabled, type NewNoteInput } from "@commonwealth/core";
import { curate, type CurateResult, type Curator } from "./curate.js";
import { approve } from "./review.js";

/** Result of {@link captureCandidates}: the staging outcome plus any notes auto-promoted. */
export interface CaptureResult extends CurateResult {
  /** Canonical repo-relative paths of notes promoted straight to canon (autoPromote). */
  promoted: string[];
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
): Promise<CaptureResult> {
  const result = await curate(brainDir, candidates, curator);
  const promoted: string[] = [];
  if (result.staged.length > 0 && (await isFeatureEnabled(brainDir, "autoPromote"))) {
    for (const note of result.staged) {
      promoted.push(await approve(brainDir, note.frontmatter.id));
    }
  }
  return { ...result, promoted };
}
