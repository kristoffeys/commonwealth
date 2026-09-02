import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  acquireSyncLock,
  buildIndex,
  listNotes,
  loadProjectAliasMap,
  NoteIdCollisionError,
  pathForNote,
  regenerateDerived,
  resolveNoteProject,
  resolveWithinBrain,
  serializeNote,
  shortId,
  sourceSegment,
  type Note,
  type NoteKind,
} from "@cmnwlth/core";

/**
 * `project relayout` (ADR-0035) — the deliberate, one-shot migration that moves canon note FILES so
 * the physical tree keys off the RESOLVED PROJECT rather than the raw `source`. Before this, a project
 * split across several repos scattered into several top-level `<source>/` folders; after it, every repo
 * of one engagement lives under a single `<project>/<kind>/` folder.
 *
 * It reverses ADR-0031's "never move files" stance (owner-approved). Provenance is preserved — `source`
 * stays in frontmatter; it just stops being the folder key. Discipline mirrors `adopt`:
 *
 * - **Single-writer + snapshot.** Real runs hold the sync lock; one `listNotes` snapshot drives the
 *   plan. A capture landing mid-relayout isn't in the snapshot and files itself correctly on its own.
 * - **Explicit, never automatic.** Existing notes move only when a human runs this; capture/promote
 *   already file NEW notes under the project, so relayout is the retroactive catch-up.
 * - **Fail closed, never overwrite.** A move publishes via link-not-rename (writeNote's #101
 *   discipline): a destination that already exists raises {@link NoteIdCollisionError} and the pass
 *   aborts before touching anything. Collisions are detected up front so no partial move happens.
 * - **Idempotent + lossless.** A note already under its target folder is left untouched (and keeps its
 *   frontmatter); a second run moves nothing. Note count is invariant across a run.
 * - **Self-describing.** A moved note gets `project:` stamped into frontmatter, so future writes stay
 *   stable even if the alias map later changes.
 */

/** One planned (or executed) file move. */
export interface RelayoutMove {
  /** Note id. */
  id: string;
  /** Note kind. */
  kind: NoteKind;
  /** Repo-relative source path (before the move). */
  from: string;
  /** Repo-relative destination path (`<project-segment>/<kind>/<id>.md`). */
  to: string;
  /** The resolved project stamped onto the note. */
  project: string;
}

/** Outcome of a relayout pass. */
export interface RelayoutResult {
  /** True when nothing was written (`--dry-run`). */
  dryRun: boolean;
  /** The project filter, when one was given. */
  projectId?: string;
  /** Moves performed (or, in dry-run, that would be performed), in listing order. */
  moves: RelayoutMove[];
  /** Notes already in their target folder (and unattributed notes), left untouched. */
  unchanged: number;
  /** Total canon notes considered (moves.length + unchanged); invariant before == after. */
  total: number;
  /** Set (with a reason) when the pass did nothing: lock contention. */
  skipped?: string;
}

/** Options for {@link relayoutBrain}. */
export interface RelayoutOptions {
  /** Report the planned moves without writing anything. */
  dryRun?: boolean;
  /** Restrict the pass to notes whose resolved project equals this id. */
  projectId?: string;
}

/** The top folder segment a note currently lives under, or "" when it sits at a kind root (unattributed). */
function currentSegment(relPath: string): string {
  const parts = relPath.split(/[\\/]/).filter((p) => p.length > 0);
  // `<seg>/<kind>/<id>.md` → 3 parts; `<kind>/<id>.md` → 2 parts (unattributed, no project folder).
  return parts.length >= 3 ? parts[0]! : "";
}

/**
 * Plan the moves for `brainDir`: for each canon note, compute its target project and where its file
 * should live, keeping only the notes whose current top folder differs from the target segment. Pure
 * w.r.t. the filesystem (a read-only snapshot); {@link relayoutBrain} executes the plan.
 */
async function planRelayout(
  brainDir: string,
  projectId: string | undefined,
): Promise<{
  moves: RelayoutMove[];
  snapshot: Map<string, Note>;
  unchanged: number;
  total: number;
}> {
  const aliasMap = await loadProjectAliasMap(brainDir);
  const notes = await listNotes(brainDir);

  const moves: RelayoutMove[] = [];
  const snapshot = new Map<string, Note>();
  let unchanged = 0;

  for (const note of notes) {
    const target = resolveNoteProject(note, aliasMap);
    // Unattributed (no source, no project) → nothing to key a folder off; leave it at the kind root.
    if (target === null || target.length === 0) {
      unchanged += 1;
      continue;
    }
    // Optional filter: only touch notes belonging to the named project.
    if (projectId !== undefined && target !== projectId) {
      unchanged += 1;
      continue;
    }
    const targetSeg = sourceSegment(target);
    if (currentSegment(note.path) === targetSeg) {
      unchanged += 1;
      continue;
    }
    const to = pathForNote(note.frontmatter.kind, note.frontmatter.id, target);
    moves.push({
      id: note.frontmatter.id,
      kind: note.frontmatter.kind,
      from: note.path,
      to,
      project: target,
    });
    snapshot.set(note.path, note);
  }

  return { moves, snapshot, unchanged, total: notes.length };
}

/**
 * Detect any destination collision BEFORE moving a single file, so the pass fails closed atomically
 * rather than partway through. A collision is a destination that already exists on disk (a different
 * note) or one targeted by two moves at once. Throws {@link NoteIdCollisionError} on the first hit.
 */
function assertNoCollisions(brainDir: string, moves: RelayoutMove[]): void {
  const claimed = new Set<string>();
  const fromSet = new Set(moves.map((m) => m.from));
  for (const m of moves) {
    if (claimed.has(m.to)) throw new NoteIdCollisionError(m.to);
    claimed.add(m.to);
    // A destination that already exists and isn't itself being vacated by this same pass is a real
    // collision with an unrelated note — never overwrite it (ADR-0003).
    const abs = resolveWithinBrain(brainDir, m.to);
    if (existsSync(abs) && !fromSet.has(m.to)) throw new NoteIdCollisionError(m.to);
  }
}

/** Publish `note` (with `project` stamped) to `toRel`, failing CLOSED on an existing destination. */
async function moveNote(
  brainDir: string,
  note: Note,
  toRel: string,
  project: string,
): Promise<void> {
  const fromAbs = resolveWithinBrain(brainDir, note.path);
  const toAbs = resolveWithinBrain(brainDir, toRel);
  const stamped: Note = { ...note, frontmatter: { ...note.frontmatter, project }, path: toRel };
  const content = serializeNote(stamped);

  await fs.mkdir(path.dirname(toAbs), { recursive: true });
  const tmp = `${toAbs}.${shortId()}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  // link+unlink (not rename) so an id collision fails CLOSED with EEXIST rather than clobbering an
  // existing note — the same discipline writeNote uses (#101, ADR-0003).
  try {
    await fs.link(tmp, toAbs);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new NoteIdCollisionError(toRel);
    throw err;
  }
  await fs.rm(tmp, { force: true });
  await fs.rm(fromAbs, { force: true });
}

/**
 * Remove now-empty `<seg>/<kind>/` and `<seg>/` directories left behind by moves. Deepest-first,
 * `rmdir` only (fails on a non-empty dir → caught + ignored), and never the brain root. The runtime/
 * derived/vcs dirs (`.commonwealth`, `staging`, `index`, `.git`, …) are never among a note's parent
 * dirs, so they are structurally out of reach.
 */
async function cleanupEmptyDirs(brainDir: string, moves: RelayoutMove[]): Promise<void> {
  const base = path.resolve(brainDir);
  const dirs = new Set<string>();
  for (const m of moves) {
    const fromAbs = resolveWithinBrain(brainDir, m.from);
    const kindDir = path.dirname(fromAbs); // <seg>/<kind>
    const segDir = path.dirname(kindDir); // <seg>
    dirs.add(kindDir);
    if (path.resolve(segDir) !== base) dirs.add(segDir);
  }
  // Deepest first so a `<seg>/<kind>` is emptied before we try `<seg>`.
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    if (path.resolve(dir) === base) continue;
    await fs.rmdir(dir).catch(() => undefined); // only removes when empty
  }
}

/**
 * Run a relayout pass over `brainDir` (see the module docstring). Never throws for lock contention
 * (returns `skipped`); DOES throw {@link NoteIdCollisionError} on a destination collision, before any
 * file is touched, so the caller can report it and the brain is left untouched.
 */
export async function relayoutBrain(
  brainDir: string,
  opts: RelayoutOptions = {},
): Promise<RelayoutResult> {
  const dryRun = opts.dryRun === true;
  const projectId = opts.projectId;

  const plan = await planRelayout(brainDir, projectId);
  const base = {
    dryRun,
    ...(projectId !== undefined ? { projectId } : {}),
    moves: plan.moves,
    unchanged: plan.unchanged,
    total: plan.total,
  };

  // Collisions fail the whole pass closed — checked for dry-run too, so a dry-run surfaces the problem.
  assertNoCollisions(brainDir, plan.moves);

  if (dryRun) return base;
  if (plan.moves.length === 0) return base; // nothing to do — skip the lock + regenerate entirely

  const release = await acquireSyncLock(brainDir);
  if (!release) return { ...base, skipped: "another writer holds the sync lock" };
  try {
    for (const m of plan.moves) {
      const note = plan.snapshot.get(m.from)!;
      await moveNote(brainDir, note, m.to, m.project);
    }
    // Regenerate first so a stale MOC in a now-empty source folder is pruned, THEN sweep the empties.
    await buildIndex(brainDir);
    await regenerateDerived(brainDir);
    await cleanupEmptyDirs(brainDir, plan.moves);
    return base;
  } finally {
    await release();
  }
}
