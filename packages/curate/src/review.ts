import { promises as fs } from "node:fs";
import path from "node:path";
import { pathForNote, type Note } from "@commonwealth/core";
import { listStaged, stagedAbsPath } from "./staging.js";

/** All notes currently awaiting review in the staging queue. */
export function listPending(brainDir: string): Promise<Note[]> {
  return listStaged(brainDir);
}

/** Find a staged note by its frontmatter id, or undefined if none matches. */
async function findStaged(brainDir: string, id: string): Promise<Note | undefined> {
  const pending = await listStaged(brainDir);
  return pending.find((n) => n.frontmatter.id === id);
}

/**
 * Approve a staged note (ADR-0007): move its file from `staging/<dir>/<id>.md` into the
 * canonical kind folder `<dir>/<id>.md`, preserving id and content, then remove the
 * staged copy. Returns the canonical repo-relative path. Throws if the id is not pending.
 */
export async function approve(brainDir: string, id: string): Promise<string> {
  const note = await findStaged(brainDir, id);
  if (!note) {
    throw new Error(`No staged note with id "${id}" to approve`);
  }
  // Promote into the same project subtree the note carries (ADR-0015), mirroring writeNote's
  // layout: `<project>/<kind>/<id>.md`, or `<kind>/<id>.md` when unattributed.
  const canonRel = pathForNote(note.frontmatter.kind, id, note.frontmatter.source);
  const canonAbs = path.join(brainDir, canonRel);
  const stagedAbs = stagedAbsPath(brainDir, note);

  await fs.mkdir(path.dirname(canonAbs), { recursive: true });
  const content = await fs.readFile(stagedAbs, "utf8");
  const tmp = `${canonAbs}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, canonAbs);
  await fs.rm(stagedAbs);
  return canonRel;
}

/** Reject a staged note (ADR-0007): discard its file. Throws if the id is not pending. */
export async function reject(brainDir: string, id: string): Promise<void> {
  const note = await findStaged(brainDir, id);
  if (!note) {
    throw new Error(`No staged note with id "${id}" to reject`);
  }
  await fs.rm(stagedAbsPath(brainDir, note));
}

/** Approve every pending staged note; returns the canonical paths, in id order. */
export async function approveAll(brainDir: string): Promise<string[]> {
  const pending = await listStaged(brainDir);
  const paths: string[] = [];
  for (const note of pending) {
    paths.push(await approve(brainDir, note.frontmatter.id));
  }
  return paths;
}
