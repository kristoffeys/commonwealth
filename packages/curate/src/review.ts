import { promises as fs } from "node:fs";
import path from "node:path";
import {
  loadProjectAliasMap,
  overwriteNote,
  pathForNote,
  resolveWithinBrain,
  type Note,
  type ProjectAliasMap,
} from "@cmnwlth/core";
import { listStaged, stagedAbsPath, stagingRoot } from "./staging.js";
import { addTombstone } from "./tombstone.js";

/** A staged note's `graduated_from` origin refs, or `undefined` if it is not a graduation candidate. */
function graduatedFrom(note: Note): string[] | undefined {
  const raw = (note.frontmatter as unknown as Record<string, unknown>).graduated_from;
  if (!Array.isArray(raw)) return undefined;
  const refs = raw.filter((r): r is string => typeof r === "string");
  return refs.length > 0 ? refs : undefined;
}

/** All notes currently awaiting review in the staging queue. */
export function listPending(brainDir: string): Promise<Note[]> {
  return listStaged(brainDir);
}

/** Canon path a staged note promotes to: keyed off its project, else its source (ADR-0035). */
export function canonPathFor(note: Note): string {
  return pathForNote(
    note.frontmatter.kind,
    note.frontmatter.id,
    note.frontmatter.project ?? note.frontmatter.source,
  );
}

/**
 * True when a populated registry exists and the staged note has no project yet. Such a note is the
 * review queue's inbox: it is never auto-promoted, and promoting it needs a project, so canon never
 * grows a folder the registry doesn't know.
 */
export function isUnassigned(note: Note, aliasMap: ProjectAliasMap): boolean {
  return Object.keys(aliasMap).length > 0 && !note.frontmatter.project;
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
export async function approve(
  brainDir: string,
  id: string,
  opts: { project?: string } = {},
): Promise<string> {
  let note = await findStaged(brainDir, id);
  if (!note) {
    throw new Error(`No staged note with id "${id}" to approve`);
  }
  const aliasMap = await loadProjectAliasMap(brainDir);
  if (opts.project) {
    if (Object.keys(aliasMap).length > 0 && !aliasMap[opts.project]) {
      throw new Error(
        `"${opts.project}" is not a project in this brain's registry; add it with \`commonwealth project link\` first`,
      );
    }
    note = { ...note, frontmatter: { ...note.frontmatter, project: opts.project } };
    await overwriteNote(stagingRoot(brainDir), note);
  }
  if (isUnassigned(note, aliasMap)) {
    throw new Error(
      `Staged note "${id}" has no project (source: ${note.frontmatter.source ?? "none"}); ` +
        `promote it with --project <id>, or link its source to a project first`,
    );
  }
  // Promote into the same folder writeNote would file it under — keyed off the RESOLVED PROJECT
  // (ADR-0035), so a note declaring a `project` lands under `<project>/<kind>/<id>.md`; a source-only
  // note under `<source>/<kind>/<id>.md`; an unattributed one at `<kind>/<id>.md`.
  const canonRel = canonPathFor(note);
  // Containment guard (#77): the schema already forbids a `..`/slash id, but assert the resolved
  // write path stays inside the brain so a crafted id/source can never escape on promote.
  const canonAbs = resolveWithinBrain(brainDir, canonRel);
  const stagedAbs = stagedAbsPath(brainDir, note);

  await fs.mkdir(path.dirname(canonAbs), { recursive: true });
  const content = await fs.readFile(stagedAbs, "utf8");
  const tmp = `${canonAbs}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, canonAbs);
  await fs.rm(stagedAbs);
  return canonRel;
}

/**
 * Reject a staged note (ADR-0007): discard its file. Throws if the id is not pending.
 *
 * When the note is an org-brain graduation candidate (it carries `graduated_from`), also record a
 * reject-tombstone (#172) so the next `graduate` pass skips re-proposing the same cross-brain
 * cluster instead of resurfacing it every run. The tombstone lives in this same brain (the
 * org-brain, where graduation candidates are staged) — see {@link addTombstone}.
 */
export async function reject(brainDir: string, id: string): Promise<void> {
  const note = await findStaged(brainDir, id);
  if (!note) {
    throw new Error(`No staged note with id "${id}" to reject`);
  }
  await fs.rm(stagedAbsPath(brainDir, note));
  const refs = graduatedFrom(note);
  if (refs) {
    await addTombstone(brainDir, {
      refs,
      title: note.frontmatter.title,
      kind: note.frontmatter.kind,
    });
  }
}

/**
 * Approve every pending staged note that has a home; returns the canonical paths, in id order.
 * Unassigned notes (see {@link isUnassigned}) stay in the queue.
 */
export async function approveAll(brainDir: string): Promise<string[]> {
  const aliasMap = await loadProjectAliasMap(brainDir);
  const pending = (await listStaged(brainDir)).filter((n) => !isUnassigned(n, aliasMap));
  const paths: string[] = [];
  for (const note of pending) {
    paths.push(await approve(brainDir, note.frontmatter.id));
  }
  return paths;
}
