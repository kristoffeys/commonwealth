import { type NewNoteInput } from "@commons/core";
import { curate, type CurateResult, type Curator } from "./curate.js";

/**
 * Capture agent-proposed notes into the staging queue (ADR-0007 #9). A thin wrapper over
 * {@link curate} that a Stop/SessionEnd hook (M4 plugin) will call with the candidates it
 * extracted from a session. Extracting candidates from the session is the hook's job, not
 * this package's — here we only gate and stage them.
 */
export function captureCandidates(
  brainDir: string,
  candidates: NewNoteInput[],
  curator?: Curator,
): Promise<CurateResult> {
  return curate(brainDir, candidates, curator);
}
