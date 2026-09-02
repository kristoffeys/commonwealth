import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildIndex,
  listNotes,
  loadProjectAliasMap,
  overwriteNote,
  pathForNote,
  persistProjectAliasMap,
  projectIdError,
  regenerateDerived,
  resolveNoteProject,
  RUNTIME_STATE_REL_PATHS,
  sourceSegment,
  type Note,
} from "@cmnwlth/core";
import { relayoutBrain } from "./relayout.js";

const pexec = promisify(execFile);

/** Pathspec `:(exclude)` args that drop the disposable runtime state from a git query. */
const RUNTIME_EXCLUDES = RUNTIME_STATE_REL_PATHS.map((p) => `:(exclude)${p}`);

/**
 * `project rename <old> <new>` (#304) — give an engagement a first-class rename. A project id is an
 * IDENTITY resolved at read time (ADR-0031), in order: the note's own `project` frontmatter → the
 * alias map (`.commonwealth/projects.json`) → the note's `source` as a singleton. The physical
 * folder keys off `sourceSegment(resolvedProjectId)` (ADR-0035). So a rename must change the id
 * wherever it is the identity, and move the folders to follow. Three moving parts, in this order:
 *
 *   1. **Alias key rename.** If `<old>` is an alias-map key, rename it to `<new>` (carrying its
 *      `sources` + optional `customer`). This is the retroactive/link tier.
 *   2. **Frontmatter re-stamp.** Every note that DECLARES `project: <old>` is rewritten to `<new>`,
 *      atomic per note (mirrors `adopt`'s `overwriteNote` snapshot discipline — a capture landing
 *      mid-rename simply isn't in the snapshot and keeps its own save-time path).
 *   3. **Relayout.** Now that every affected note RESOLVES to `<new>`, reuse {@link relayoutBrain}
 *      (with `projectId: <new>`) to move files out of the old-segment folder into `<new>/<kind>/…`.
 *      Steps 1–2 run BEFORE this so the move engine sees the new resolved identity.
 *
 * The whole thing lands as ONE coherent commit (git brains), like `adopt`: the alias-map edit, the
 * re-stamps, the file moves and the regenerated derived index all in a single reviewable change.
 * Refuses on a dirty worktree so nothing unrelated rides along. Never silently MERGES two projects:
 * a `<new>` that already exists as an alias-map key is refused (ADR-0003, confirmation over
 * inference).
 */

/** A note whose declared `project` frontmatter was (or, in dry-run, would be) rewritten old → new. */
export interface RenameRestamp {
  /** Note id. */
  id: string;
  /** Repo-relative path (before any relayout move). */
  path: string;
}

/** One file move the relayout performed (or, in dry-run, projected). */
export interface RenameMove {
  /** Repo-relative source path. */
  from: string;
  /** Repo-relative destination path (`<new-segment>/<kind>/<id>.md`). */
  to: string;
}

/** Outcome of a rename pass. */
export interface RenameResult {
  /** The old project id. */
  oldId: string;
  /** The new project id. */
  newId: string;
  /** True when nothing was written (`--dry-run`). */
  dryRun: boolean;
  /** True when `<old>` was an alias-map key that got renamed to `<new>`. */
  keyRenamed: boolean;
  /** Sources carried on the renamed alias entry (empty when `<old>` was not a key). */
  sources: string[];
  /** The renamed entry's customer, when it carried one. */
  customer?: string;
  /** Notes whose declared `project` frontmatter was (or would be) rewritten, in listing order. */
  restamped: RenameRestamp[];
  /** File moves performed (or projected in dry-run), in listing order. */
  moves: RenameMove[];
  /** True when a single rename commit was made (git brain, real run, with changes). */
  committed: boolean;
  /** Short sha of the rename commit, when one was made. */
  commit?: string;
  /** Set (with a reason) when the pass did nothing: invalid id, collision, unknown old, dirty tree. */
  skipped?: string;
}

/** Options for {@link renameProject}. */
export interface RenameOptions {
  /** Report the plan (key rename + re-stamps + move plan) without writing anything. */
  dryRun?: boolean;
}

/**
 * The top folder segment a note currently lives under, or "" when it sits at a kind root
 * (unattributed). Mirrors `relayout`'s private helper: `<seg>/<kind>/<id>.md` → 3 parts (a project
 * folder); `<kind>/<id>.md` → 2 parts (no project folder). Replicated here (not exported from
 * relayout) so the dry-run move projection matches the real relayout plan exactly.
 */
function currentSegment(relPath: string): string {
  const parts = relPath.split(/[\\/]/).filter((p) => p.length > 0);
  return parts.length >= 3 ? parts[0]! : "";
}

/**
 * True when `brainDir` has meaningful uncommitted changes. Mirrors `adopt`'s gate: the brain's
 * disposable runtime state (sync lock, daemon pid) is EXCLUDED so a legacy brain whose `.gitignore`
 * predates those entries doesn't read its own `?? .commonwealth/sync.lock` as dirt (#241). Genuine
 * dirt still refuses. Git errors → not dirty (the caller already gated on `.git`).
 */
async function worktreeDirty(brainDir: string): Promise<boolean> {
  try {
    const { stdout } = await pexec("git", [
      "-C",
      brainDir,
      "status",
      "--porcelain",
      "--",
      ".",
      ...RUNTIME_EXCLUDES,
    ]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Stage everything and make ONE rename commit in `brainDir`. Returns the short sha, or null when
 * there was nothing to commit or git failed. Mirrors `adopt`'s `commitAdoption`: unstages the
 * disposable runtime state so a legacy brain never rides the lock/pid into the commit, and falls
 * back to a generic committer identity only when none is configured (fresh machine / CI).
 */
async function commitRename(
  brainDir: string,
  oldId: string,
  newId: string,
): Promise<string | null> {
  try {
    await pexec("git", ["-C", brainDir, "add", "-A"]);
    await pexec("git", ["-C", brainDir, "reset", "-q", "--", ...RUNTIME_STATE_REL_PATHS]).catch(
      () => undefined,
    );
    const { stdout: staged } = await pexec("git", [
      "-C",
      brainDir,
      "diff",
      "--cached",
      "--name-only",
    ]);
    if (staged.trim().length === 0) return null; // nothing changed — don't create an empty commit
    let identity: string[] = [];
    try {
      const email = (await pexec("git", ["-C", brainDir, "config", "user.email"])).stdout.trim();
      if (email.length === 0) throw new Error("no identity");
    } catch {
      identity = ["-c", "user.name=Commonwealth", "-c", "user.email=commonwealth@localhost"];
    }
    const msg = `chore(project): rename "${oldId}" -> "${newId}"`;
    await pexec("git", ["-C", brainDir, ...identity, "commit", "-q", "-m", msg]);
    const { stdout: sha } = await pexec("git", ["-C", brainDir, "rev-parse", "--short", "HEAD"]);
    return sha.trim();
  } catch {
    return null;
  }
}

/**
 * Run a rename pass over `brainDir`, changing project id `oldId` to `newId` (see the module
 * docstring). Never throws for an ordinary refusal (invalid id, collision, unknown old, dirty
 * worktree) — it returns a result with `skipped` set so the CLI can print a clear message and exit
 * non-zero. A destination collision during the relayout phase DOES propagate (fails closed, ADR-0003).
 */
export async function renameProject(
  brainDir: string,
  oldId: string,
  newId: string,
  opts: RenameOptions = {},
): Promise<RenameResult> {
  const dryRun = opts.dryRun === true;
  const skip = (reason: string): RenameResult => ({
    oldId,
    newId,
    dryRun,
    keyRenamed: false,
    sources: [],
    restamped: [],
    moves: [],
    committed: false,
    skipped: reason,
  });

  // Validate the TARGET id at ingestion — a rename stamps `<new>` onto potentially many notes, so a
  // pathological value must be rejected before it's mass-written (#241 discipline, reused for #304).
  const idErr = projectIdError(newId);
  if (idErr) return skip(`invalid project id: ${idErr}`);

  const aliasMap = await loadProjectAliasMap(brainDir);
  // Refuse to MERGE: `<new>` already naming an engagement in the map is a distinct project — never
  // fold two into one silently (ADR-0003, confirmation over inference). The curator must pick a
  // free id (or unlink the existing one first).
  if (aliasMap[newId]) return skip(`project "${newId}" already exists in the alias map`);

  const oldEntry = aliasMap[oldId];
  const notes = await listNotes(brainDir);

  // Every note that DECLARES `project: <old>` in its own frontmatter — the save-time tier we rewrite.
  const declaredOld = notes.filter((n) => n.frontmatter.project === oldId);
  // Every note that RESOLVES to `<old>` today (declared + alias-linked + source-singleton), against
  // the CURRENT map. Used both to prove `<old>` exists at all and to project the dry-run move plan.
  const resolvesToOld = notes.filter((n) => resolveNoteProject(n, aliasMap) === oldId);

  // `<old>` must name SOMETHING: an alias key, a declared frontmatter id, or a resolved identity.
  if (!oldEntry && resolvesToOld.length === 0) return skip(`no project "${oldId}" found`);

  const sources = oldEntry ? [...oldEntry.sources].sort() : [];
  const base = {
    oldId,
    newId,
    dryRun,
    keyRenamed: Boolean(oldEntry),
    sources,
    ...(oldEntry?.customer ? { customer: oldEntry.customer } : {}),
    restamped: declaredOld.map((n) => ({ id: n.frontmatter.id, path: n.path })),
  };

  if (dryRun) {
    // Project the relayout WITHOUT writing: after the rename every note in `resolvesToOld` resolves
    // to `<new>`, so its file should live under `sourceSegment(<new>)`. Compute the same plan
    // `relayoutBrain` would (it can't see the not-yet-applied rename, so we mirror its planning).
    const targetSeg = sourceSegment(newId);
    const moves: RenameMove[] = [];
    for (const n of resolvesToOld) {
      if (currentSegment(n.path) === targetSeg) continue; // already under the target folder
      moves.push({ from: n.path, to: pathForNote(n.frontmatter.kind, n.frontmatter.id, newId) });
    }
    return { ...base, moves, committed: false };
  }

  // Real run. Refuse on a dirty worktree so the rename is the only thing in its commit (adopt gate).
  const isGit = existsSync(path.join(brainDir, ".git"));
  if (isGit && (await worktreeDirty(brainDir))) {
    return skip("brain worktree is dirty — commit or stash your changes first, then retry");
  }

  // 1. Rename the alias-map key, carrying its sources + customer. Guarded atomic write.
  if (oldEntry) {
    await persistProjectAliasMap(brainDir, (m) => {
      const entry = m[oldId];
      if (!entry) return; // vanished between load and write — nothing to rename
      delete m[oldId];
      m[newId] = entry;
    });
  }

  // 2. Re-stamp every note declaring `project: <old>` → `<new>`, atomic per note (overwriteNote is
  // containment-guarded). A note the snapshot missed keeps its own save-time stamping path.
  for (const n of declaredOld) {
    const updated: Note = { ...n, frontmatter: { ...n.frontmatter, project: newId } };
    await overwriteNote(brainDir, updated);
  }

  // 3. Move files so folders follow the new id. relayoutBrain manages its own sync lock, moves via
  // link-not-rename (fails CLOSED on a destination collision), stamps `project` onto moved notes,
  // and regenerates the derived index — all scoped to `<new>` so unrelated projects are untouched.
  const relayout = await relayoutBrain(brainDir, { projectId: newId });
  const moves: RenameMove[] = relayout.moves.map((m) => ({ from: m.from, to: m.to }));

  // relayout only regenerates derived when it actually moved something. When the key rename changed
  // the grouping but no file needed to move (every note already sat under the target segment), the
  // router headings still have to be rebuilt off the new id — do it here.
  if (relayout.moves.length === 0) {
    await buildIndex(brainDir);
    await regenerateDerived(brainDir);
  }

  let committed = false;
  let commit: string | undefined;
  if (isGit) {
    const sha = await commitRename(brainDir, oldId, newId);
    if (sha) {
      committed = true;
      commit = sha;
    }
  }

  return { ...base, moves, committed, ...(commit ? { commit } : {}) };
}
