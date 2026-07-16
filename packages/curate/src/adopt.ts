import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  acquireSyncLock,
  buildIndex,
  listNotes,
  loadProjectAliasMap,
  overwriteNote,
  persistProjectAliasMap,
  regenerateDerived,
  RUNTIME_STATE_REL_PATHS,
  slugify,
  unlinkSources,
  type Note,
} from "@cmnwlth/core";
import { listStaged } from "./staging.js";

const pexec = promisify(execFile);

/** Pathspec `:(exclude)` args that drop the disposable runtime state from a git query. */
const RUNTIME_EXCLUDES = RUNTIME_STATE_REL_PATHS.map((p) => `:(exclude)${p}`);

/**
 * `project adopt` (ADR-0031 / #241) — the deliberate promotion of a PROVEN alias-map link into
 * permanent note frontmatter. #239 gives two identity tiers: save-time `project` frontmatter
 * (primary — new notes are self-contained) and the read-time alias map (retroactive — links
 * pre-existing notes in one reversible line). Adoption makes the map strictly transitional: once a
 * link is trusted, the identity moves ONTO the notes and the map entry retires, keeping the mental
 * model simple ("a note carries its project").
 *
 * It is a conscious canon edit, same moral category as `consolidate`: opt-in, atomic (one commit),
 * run at a chosen quiet moment on a proven link — NOT the routine linking mechanism #239 rejected
 * for concurrent-writer conflicts. Discipline:
 *
 * - **Snapshot + atomic per-file writes.** One `listNotes` snapshot; each stamp is an atomic
 *   tmp+rename via `overwriteNote` (containment-guarded). A capture landing mid-adopt simply isn't
 *   in the snapshot — it keeps its own save-time stamping path and is neither lost nor corrupted.
 * - **Never clobbers a different identity.** A note whose frontmatter already carries a DIFFERENT
 *   `project` is left untouched and reported as a conflict (human eyes needed).
 * - **One reviewable commit** (git brains) naming the project + note count, with the derived index
 *   regenerated in the same pass — refuses to run on a dirty worktree. Non-git brains: writes only.
 * - **Retires the redundant entry.** Sources with ≥1 adopted note are dropped from the map (their
 *   notes now carry the project); sources with zero adopted notes are KEPT (the link still resolves
 *   future no-project captures). The whole entry goes when nothing is left to keep.
 */

/** A note left untouched because its frontmatter already declares a different project. */
export interface AdoptConflict {
  /** Note id. */
  id: string;
  /** Repo-relative path (unchanged). */
  path: string;
  /** The note's `source` (which the alias entry links). */
  source: string;
  /** The DIFFERENT project the note already declares. */
  existingProject: string;
}

/** Per-source tally for an adoption (populated for dry-run and real runs alike). */
export interface AdoptSourceReport {
  /** The linked `source`. */
  source: string;
  /** Canon notes stamped (or would be, in dry-run). */
  adopted: number;
  /** Canon notes with a different project, left untouched. */
  conflicts: number;
  /** Staging-queue notes with this source — never adopted (canon only), reported for awareness. */
  staged: number;
}

/** Outcome of an adoption pass. */
export interface AdoptResult {
  /** The project id adopted. */
  project: string;
  /** The entry's customer, when it carried one (stamped as a `customer:<slug>` tag). */
  customer?: string;
  /** True when nothing was written (`--dry-run`). */
  dryRun: boolean;
  /** Per-source tallies, in source order. */
  perSource: AdoptSourceReport[];
  /** Every canon note stamped (or would-be), in listing order. */
  adopted: { id: string; path: string; source: string }[];
  /** Notes left untouched because they declare a different project. */
  conflicts: AdoptConflict[];
  /** Total staging-queue matches (not adopted). */
  stagedMatches: number;
  /** True when a single adoption commit was made (git brains, real run, with changes). */
  committed: boolean;
  /** Short sha of the adoption commit, when one was made. */
  commit?: string;
  /** True when the alias entry was removed entirely (no zero-adopted sources remained). */
  entryRemoved: boolean;
  /** Sources retained in the alias entry (had zero adopted notes; the link still carries value). */
  keptSources: string[];
  /** Set (with a reason) when the pass did nothing: no such project, dirty worktree, or lock held. */
  skipped?: string;
}

/** Options for {@link adoptProject}. */
export interface AdoptOptions {
  /** Report the plan (per-source counts + conflicts) without writing anything. */
  dryRun?: boolean;
}

/**
 * True when `brainDir` has meaningful uncommitted changes. The brain's disposable runtime state (the
 * sync lock we're holding, a daemon's PID file) is EXCLUDED — otherwise adopt would refuse on every
 * legacy brain, whose `.gitignore` predates those entries, seeing its own `?? .commonwealth/sync.lock`
 * as dirt (#241 legacy-brain regression). Genuine dirt (edited notes, other untracked files) still
 * refuses. Git errors → not dirty (the caller already gated on `.git`).
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
    return false; // git missing / not a repo — the caller already gated on `.git`
  }
}

/**
 * Stage everything and make ONE adoption commit in `brainDir`. Returns the short sha, or null when
 * there was nothing to commit (a no-op adoption) or git failed. Falls back to a generic committer
 * identity only when none is configured (fresh machine / CI), mirroring the scaffold commit.
 */
async function commitAdoption(
  brainDir: string,
  projectId: string,
  noteCount: number,
): Promise<string | null> {
  try {
    await pexec("git", ["-C", brainDir, "add", "-A"]);
    // Never commit disposable runtime state. On a LEGACY brain (no gitignore entry) `add -A` would
    // otherwise stage `.commonwealth/sync.lock`/`sync.pid`, committing the lock and leaving a
    // deleted-lock dirt after release. Unstage them — mirrors the sync engine's pre-commit scrub.
    await pexec("git", ["-C", brainDir, "reset", "-q", "--", ...RUNTIME_STATE_REL_PATHS]).catch(
      () => undefined,
    );
    // Look at the INDEX (staged set) directly, so leftover untracked runtime files don't read as
    // "there is something to commit" and produce an empty/no-op commit.
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
    const msg = `chore(project): adopt "${projectId}" onto ${noteCount} note(s)`;
    await pexec("git", ["-C", brainDir, ...identity, "commit", "-q", "-m", msg]);
    const { stdout: sha } = await pexec("git", ["-C", brainDir, "rev-parse", "--short", "HEAD"]);
    return sha.trim();
  } catch {
    return null;
  }
}

/**
 * Run an adoption pass over `brainDir` for `projectId` (see the module docstring). Never throws for
 * an ordinary refusal (missing project, dirty worktree, lock contention) — it returns a result with
 * `skipped` set so the CLI can print a clear message and exit non-zero.
 */
export async function adoptProject(
  brainDir: string,
  projectId: string,
  opts: AdoptOptions = {},
): Promise<AdoptResult> {
  const dryRun = opts.dryRun === true;
  const skip = (reason: string): AdoptResult => ({
    project: projectId,
    dryRun,
    perSource: [],
    adopted: [],
    conflicts: [],
    stagedMatches: 0,
    committed: false,
    entryRemoved: false,
    keptSources: [],
    skipped: reason,
  });

  const map = await loadProjectAliasMap(brainDir);
  const entry = map[projectId];
  if (!entry) return skip(`no project "${projectId}" in the alias map`);

  const isGit = existsSync(path.join(brainDir, ".git"));

  // Real writes are single-writer (the sync lock, as consolidate uses) and refuse on a dirty
  // worktree so the adoption is the only thing in its commit. Dry-run needs neither.
  const release = dryRun ? null : await acquireSyncLock(brainDir);
  if (!dryRun && !release) return skip("another writer holds the sync lock");
  try {
    if (!dryRun && isGit && (await worktreeDirty(brainDir))) {
      return skip("brain worktree is dirty — commit or stash your changes first, then retry");
    }

    const sourceSet = new Set(entry.sources);
    const customerTag = entry.customer ? `customer:${slugify(entry.customer)}` : null;

    // One snapshot listing. A note captured after this point isn't adopted (it keeps its own
    // save-time stamping path) — the snapshot is what makes a concurrent capture safe.
    const notes = await listNotes(brainDir);
    const staged = await listStaged(brainDir);

    const perSource = new Map<string, AdoptSourceReport>(
      entry.sources.map((s) => [s, { source: s, adopted: 0, conflicts: 0, staged: 0 }]),
    );

    const toStamp: Note[] = [];
    const adopted: AdoptResult["adopted"] = [];
    const conflicts: AdoptConflict[] = [];

    for (const n of notes) {
      const src = n.frontmatter.source;
      if (typeof src !== "string" || !sourceSet.has(src)) continue;
      const declared = n.frontmatter.project;
      if (typeof declared === "string" && declared.length > 0) {
        if (declared === projectId) continue; // already adopted — nothing to do
        conflicts.push({
          id: n.frontmatter.id,
          path: n.path,
          source: src,
          existingProject: declared,
        });
        perSource.get(src)!.conflicts += 1;
        continue;
      }
      toStamp.push(n);
      adopted.push({ id: n.frontmatter.id, path: n.path, source: src });
      perSource.get(src)!.adopted += 1;
    }

    let stagedMatches = 0;
    for (const n of staged) {
      const src = n.frontmatter.source;
      if (typeof src === "string" && sourceSet.has(src)) {
        stagedMatches += 1;
        perSource.get(src)!.staged += 1;
      }
    }

    const perSourceList = [...entry.sources].sort().map((s) => perSource.get(s)!);
    const base = {
      project: projectId,
      ...(entry.customer ? { customer: entry.customer } : {}),
      dryRun,
      perSource: perSourceList,
      adopted,
      conflicts,
      stagedMatches,
    };

    if (dryRun) {
      return { ...base, committed: false, entryRemoved: false, keptSources: [] };
    }

    // Stamp each adoptable note in place: set `project`, and add the `customer:<slug>` tag when the
    // entry names a customer (idempotent). Atomic per-file, containment-guarded by overwriteNote.
    for (const n of toStamp) {
      const tags =
        customerTag && !n.frontmatter.tags.includes(customerTag)
          ? [...n.frontmatter.tags, customerTag]
          : n.frontmatter.tags;
      await overwriteNote(brainDir, {
        ...n,
        frontmatter: { ...n.frontmatter, project: projectId, tags },
      });
    }

    // Retire the now-redundant part of the alias entry. A source with ≥1 adopted note is redundant
    // (its notes carry the project via frontmatter, which wins); a source with zero adopted notes
    // still resolves future no-project captures, so keep it. Drop the redundant ones; unlinkSources
    // deletes the whole entry when none remain.
    const adoptedSources = entry.sources.filter((s) => perSource.get(s)!.adopted > 0);
    const keptSources = entry.sources.filter((s) => perSource.get(s)!.adopted === 0);
    if (adoptedSources.length > 0) {
      await persistProjectAliasMap(brainDir, (m) => unlinkSources(m, projectId, adoptedSources));
    }
    const entryRemoved = keptSources.length === 0;

    // Regenerate derived in the same pass. The output is byte-identical to before the adoption:
    // the router grouped these notes by the alias tier, now it groups them by the frontmatter tier,
    // and both resolve to the same project (the read-time/save-time agreement invariant, ADR-0031).
    await buildIndex(brainDir);
    await regenerateDerived(brainDir);

    let committed = false;
    let commit: string | undefined;
    if (isGit) {
      const sha = await commitAdoption(brainDir, projectId, adopted.length);
      if (sha) {
        committed = true;
        commit = sha;
      }
    }

    return {
      ...base,
      committed,
      ...(commit ? { commit } : {}),
      entryRemoved,
      keptSources,
    };
  } finally {
    if (release) await release();
  }
}
