import { promises as fs } from "node:fs";
import path from "node:path";
import { makeNoteId, parseNote, serializeNote, writeNote, type Note } from "@commonwealth/core";
import { openRepo, scrubStagedSecrets } from "./git.js";

/** One conflicting note, split into its two surviving sibling files. */
export interface ResolvedConflict {
  /** The path git reported as conflicted (repo-relative). */
  original: string;
  /** Repo-relative path of the file holding the local ("ours", stage :2) content. */
  oursPath: string;
  /** Repo-relative path of the file holding the incoming ("theirs", stage :3) content. */
  theirsPath: string;
}

/** Read a specific merge stage of a path via `git show :<stage>:<path>`; null if absent. */
async function showStage(dir: string, stage: 2 | 3, relPath: string): Promise<string | null> {
  try {
    return await openRepo(dir).raw(["show", `:${stage}:${relPath}`]);
  } catch {
    return null; // add/add on one side only, or the stage doesn't exist
  }
}

/**
 * Rewrite one side's raw content so it lands as a NEW, distinct note file: fresh id +
 * matching filename, so ours and theirs coexist instead of overwriting each other.
 * Falls back to writing the raw bytes verbatim (under `suffix`) if it isn't parseable
 * frontmatter — we never lose content.
 */
async function writeSibling(
  brainDir: string,
  relPath: string,
  raw: string,
  side: "ours" | "theirs",
): Promise<string> {
  const dir = path.posix.dirname(relPath);
  const base = path.posix.basename(relPath, ".md");

  let note: Note | null = null;
  try {
    note = parseNote(raw, relPath);
  } catch {
    note = null;
  }

  if (note) {
    // Give it a brand-new id/filename so it can never collide with the other side.
    const newId = makeNoteId(`${note.frontmatter.title} (${side})`, note.frontmatter.created);
    const newRel = `${dir}/${newId}.md`;
    const rewritten: Note = {
      ...note,
      frontmatter: { ...note.frontmatter, id: newId },
      path: newRel,
    };
    await fs.writeFile(path.join(brainDir, newRel), serializeNote(rewritten), "utf8");
    return newRel;
  }

  // Unparseable — preserve raw bytes under a unique, obviously-derived name.
  const newRel = `${dir}/${base}-${side}-${randomTag()}.md`;
  await fs.writeFile(path.join(brainDir, newRel), raw, "utf8");
  return newRel;
}

function randomTag(): string {
  return Math.random().toString(36).slice(2, 6);
}

/**
 * Resolve same-file conflicts without data loss (ADR-0003 §c / issue #8). For each
 * conflicted note:
 *   - extract BOTH the local ("ours", stage :2) and incoming ("theirs", stage :3) content,
 *   - write each as a SEPARATE sibling note (at least one gets a fresh {@link makeNoteId}
 *     id/filename so they coexist),
 *   - remove the original conflicted path (its content survives in the siblings, with no
 *     git conflict markers anywhere),
 *   - record a `conflict`-tagged memory note naming the two siblings for human review.
 * Then stage everything and continue the in-progress rebase to completion.
 */
export async function resolveConflictsAsSiblings(
  brainDir: string,
  conflictedPaths: string[],
): Promise<ResolvedConflict[]> {
  const git = openRepo(brainDir);
  const resolved: ResolvedConflict[] = [];

  for (const relPath of conflictedPaths) {
    const oursRaw = await showStage(brainDir, 2, relPath);
    const theirsRaw = await showStage(brainDir, 3, relPath);
    const abs = path.join(brainDir, relPath);

    // Both sides present: split into two siblings, drop the marker-laden original.
    if (oursRaw !== null && theirsRaw !== null) {
      const oursPath = await writeSibling(brainDir, relPath, oursRaw, "ours");
      const theirsPath = await writeSibling(brainDir, relPath, theirsRaw, "theirs");
      await fs.rm(abs, { force: true });
      resolved.push({ original: relPath, oursPath, theirsPath });
      continue;
    }

    // One side only (add/delete): keep whichever content exists, verbatim, no markers.
    const survivor = oursRaw ?? theirsRaw;
    if (survivor !== null) {
      await fs.writeFile(abs, survivor, "utf8");
      resolved.push({ original: relPath, oursPath: relPath, theirsPath: relPath });
    } else {
      // Neither stage has content (delete/delete) — accept the deletion.
      await fs.rm(abs, { force: true });
      resolved.push({ original: relPath, oursPath: relPath, theirsPath: relPath });
    }
  }

  // File a review record BEFORE staging, so it's committed alongside the resolution.
  if (resolved.length > 0) {
    const lines = resolved.map(
      (r) => `- \`${r.original}\` → ours: \`${r.oursPath}\`, theirs: \`${r.theirsPath}\``,
    );
    await writeNote(brainDir, {
      kind: "memory",
      title: `Sync conflict resolved as siblings (${resolved.length})`,
      tags: ["conflict"],
      body: [
        "A same-file sync conflict was auto-resolved without data loss: both versions",
        "were kept as separate sibling notes for review. Reconcile and supersede as needed.",
        "",
        ...lines,
      ].join("\n"),
    });
  }

  // Stage the resolution and advance the rebase. `--continue` may stop again on the next
  // replayed commit's conflict (nonzero exit) — that's expected; the engine loops back and
  // calls us again. An emptied commit needs `--skip` instead. Swallow both; only a truly
  // unexpected failure with no conflicts and no rebase left in progress re-throws.
  await git.add(["-A"]);
  // Re-scrub before committing: `add -A` above (re)stages EVERYTHING in the worktree, including
  // a secret note that the engine's pre-commit scrub deliberately left unstaged (and, for a new
  // note, untracked — which `rebase --autostash` does not stash). Without this, `rebase --continue`
  // would fold that secret into the resolution commit and the engine would push it (#98). The
  // unstaged secret note stays in the worktree and is reported by the engine's step-4 scrub.
  await scrubStagedSecrets(brainDir);
  try {
    // openRepo injects core.editor=true, so --continue records the resolution commit
    // non-interactively instead of trying to open an editor.
    await git.raw(["rebase", "--continue"]);
  } catch {
    const status = await git.status();
    if (status.conflicted.length === 0) {
      // Nothing conflicting left but continue failed → likely an emptied commit; skip it.
      try {
        await git.raw(["rebase", "--skip"]);
      } catch {
        // Fall through — engine re-checks rebase state and will surface a real failure.
      }
    }
  }

  return resolved;
}
