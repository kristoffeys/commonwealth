import path from "node:path";
import { listNotes, writeNote, type NewNoteInput, type Note } from "@commonwealth/core";

/** Subtree of a brain that holds proposed (not-yet-approved) notes. */
const STAGING_DIR = "staging";

/**
 * Absolute path to the staging subtree of a brain. Staged notes are ordinary notes
 * rooted here instead of at the brain root, so core note IO works unchanged (ADR-0007).
 */
export function stagingRoot(brainDir: string): string {
  return path.join(brainDir, STAGING_DIR);
}

/**
 * Write a candidate note into the brain's `staging/` subtree. Returns the staged
 * {@link Note}; its `path` is relative to the staging root (e.g. `memory/<id>.md`),
 * so it is deliberately NOT visible to `listNotes(brainDir)` (canon).
 */
export function stageNote(brainDir: string, input: NewNoteInput): Promise<Note> {
  return writeNote(stagingRoot(brainDir), input);
}

/** List every note currently staged for review under `staging/`. */
export function listStaged(brainDir: string): Promise<Note[]> {
  return listNotes(stagingRoot(brainDir));
}

/** Absolute filesystem path of a staged note (whose `path` is staging-root-relative). */
export function stagedAbsPath(brainDir: string, note: Note): string {
  return path.join(stagingRoot(brainDir), note.path);
}
