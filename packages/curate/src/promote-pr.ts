import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  findSecretsForBrain,
  listNotes,
  loadBrainConfig,
  pathForNote,
  resolveWithinBrain,
  type Note,
} from "@cmnwlth/core";
import { listStaged, stagedAbsPath } from "./staging.js";

const pexec = promisify(execFile);

/**
 * `promote --pr` (ADR-0007, #215) — curation as a brain-repo pull request. Instead of moving staged
 * notes straight into canon locally, it opens a branch that ADDS the notes at their canonical paths
 * and files a PR for review. Merging the PR IS the promotion (union-merge-safe by ADR-0003: one
 * fact per file, collision-proof ids); closing it discards the branch and changes nothing.
 *
 * ## The staging-is-local wrinkle (ADR-0008)
 *
 * `staging/` is gitignored — it is a PER-USER local review queue, never synced. So the PR branch
 * *cannot* carry a "remove the staged copy" change: there is nothing tracked to remove, and other
 * teammates have their own independent queues. The branch therefore carries **canon adds only**,
 * and the promoter's local staged copies are left in place. They are reconciled AFTER the PR lands
 * by {@link reconcilePromoted}: the next `promote`/`status` sees the note now exists in canon (by
 * id) and clears the matching staged copy locally. If the PR is closed unmerged, the note never
 * reaches canon, the sweep never fires, and the staged copy survives — so re-promoting is trivial.
 * Every teammate's queue is untouched throughout, because staging is per-user.
 *
 * The commit is built with git plumbing against a TEMP index (`GIT_INDEX_FILE`), so the brain's
 * working tree and the user's in-progress state are never touched — no checkout, no stash, no
 * disruption to a concurrent capture.
 */

/** One note carried by a promotion PR. */
export interface PromotePrNote {
  id: string;
  kind: string;
  title: string;
  /** The note's capture `source` (repo identity), when it has one. */
  source?: string;
  /** Canonical repo-relative path the branch adds the note at. */
  canonPath: string;
}

/**
 * A staged note WITHHELD from a promotion PR because the secret scrub (#16/#98, at parity with the
 * sync pre-commit scrub) detected a credential in its content. Withheld notes are never hashed into
 * the promotion commit and never pushed; the local staged copy is left untouched so the user can fix
 * and re-promote.
 */
export interface WithheldNote extends PromotePrNote {
  /** Secret-pattern kinds that matched (deduped), e.g. "aws-access-key-id". Names the rule hit. */
  rules: string[];
}

/** Outcome of a `promote --pr` run. */
export interface PromotePrResult {
  /** The promotion branch created and pushed. */
  branch: string;
  /** The base branch the PR targets (the brain's current HEAD branch). */
  base: string;
  /** Short sha of the promotion commit. */
  commit: string;
  /** The created PR's URL (whatever `gh pr create` printed). */
  url: string;
  /** The PR title. */
  title: string;
  /** The PR body (markdown). */
  body: string;
  /** Notes carried by the PR, in selection order (clean notes only — see {@link withheld}). */
  notes: PromotePrNote[];
  /** Staged notes withheld from the PR because the secret scrub found a credential (#16/#98). */
  withheld: WithheldNote[];
  /**
   * Set (with a reason) when nothing was done: no remote, no `gh`, an empty selection, or EVERY
   * selected note was withheld by the secret scan (no branch/PR is created in that case).
   */
  skipped?: string;
}

/** Which staged notes to promote: everything pending, or an explicit id list. */
export type PromoteSelection = { all: true } | { ids: string[] };

/**
 * Injectable IO seam so the round-trip test can drive real git against a local bare remote while
 * stubbing `gh` (recording argv, returning a fake URL). Defaults to spawning the real binaries in
 * `brainDir`.
 */
export interface PromotePrIo {
  /** Run git in the brain; returns trimmed stdout. Rejects on non-zero exit. */
  git(args: string[], env?: Record<string, string>): Promise<string>;
  /** True when the `gh` CLI is available on PATH. */
  ghAvailable(): Promise<boolean>;
  /** Run `gh` in the brain; returns trimmed stdout (the created PR URL for `pr create`). */
  gh(args: string[]): Promise<string>;
  /** Clock for branch naming (injectable so tests get stable names). */
  now(): number;
}

/** Real IO: git/gh spawned in `brainDir`. */
export function defaultPromotePrIo(brainDir: string): PromotePrIo {
  return {
    async git(args, env) {
      const { stdout } = await pexec(
        "git",
        ["-C", brainDir, ...args],
        env ? { env: { ...process.env, ...env } } : {},
      );
      return stdout.trim();
    },
    async ghAvailable() {
      try {
        await pexec("gh", ["--version"]);
        return true;
      } catch {
        return false;
      }
    },
    async gh(args) {
      const { stdout } = await pexec("gh", args, { cwd: brainDir });
      return stdout.trim();
    },
    now: () => Date.now(),
  };
}

/** The committer identity flags: honor a configured git identity, else fall back (mirrors scaffold). */
async function identityFlags(io: PromotePrIo): Promise<string[]> {
  try {
    const email = await io.git(["config", "user.email"]);
    if (email.length === 0) throw new Error("no identity");
    return [];
  } catch {
    return ["-c", "user.name=Commonwealth", "-c", "user.email=commonwealth@localhost"];
  }
}

/**
 * Build the PR title + body listing each promoted note (kind, title, source). When `withheldCount`
 * is non-zero the batch was trimmed by the secret scrub, so the body says so loudly ("N withheld by
 * secret scan") — the reviewer must know the promotion is incomplete.
 */
function renderPr(notes: PromotePrNote[], withheldCount = 0): { title: string; body: string } {
  const count = notes.length;
  const title =
    count === 1
      ? `Promote note into canon: ${notes[0]!.title}`
      : `Promote ${count} notes into canon`;

  const lines = notes.map((n) => {
    const src = n.source ? ` — source \`${n.source}\`` : "";
    return `- **[${n.kind}]** ${n.title}${src}  (\`${n.id}\` → \`${n.canonPath}\`)`;
  });

  const withheldBanner =
    withheldCount > 0
      ? [
          `> ⚠️ **${withheldCount} withheld by secret scan.** This promotion batch is INCOMPLETE — ` +
            `${withheldCount} selected note(s) contained a detected secret and were held back (left ` +
            `staged locally, never pushed). Fix the secret(s) and re-run to promote them.`,
          "",
        ]
      : [];

  const body = [
    `Promotes ${count} staged note${count === 1 ? "" : "s"} into the Commonwealth brain canon.`,
    "",
    ...withheldBanner,
    "**Merge = promotion.** Adds are union-merge-safe (one fact per file, collision-proof ids — ADR-0003).",
    "**Close = reject.** Closing discards the branch; nothing enters canon and no teammate's queue is",
    "affected — the staging queue is per-user and gitignored (ADR-0008).",
    "",
    "## Notes",
    ...lines,
    "",
  ].join("\n");

  return { title, body };
}

/**
 * Open a PR that promotes the selected staged notes into canon (see the module docstring). Never
 * throws for an ordinary refusal (non-git or remote-less brain, `gh` absent, empty selection) — it
 * returns a result with `skipped` set so the CLI prints a clear message and exits non-zero. Throws
 * only for a genuine usage error (an id that is not in the staging queue).
 */
export async function promoteViaPr(
  brainDir: string,
  selection: PromoteSelection,
  io: PromotePrIo = defaultPromotePrIo(brainDir),
): Promise<PromotePrResult> {
  const skip = (reason: string, withheld: WithheldNote[] = []): PromotePrResult => ({
    branch: "",
    base: "",
    commit: "",
    url: "",
    title: "",
    body: "",
    notes: [],
    withheld,
    skipped: reason,
  });

  if (!existsSync(path.join(brainDir, ".git"))) {
    return skip("this brain is not a git repository — `commonwealth promote --pr` needs a remote");
  }

  // A git remote is required to push the branch. Remote-less (local-only) brains keep terminal promote.
  try {
    const origin = await io.git(["remote", "get-url", "origin"]);
    if (origin.length === 0) throw new Error("empty origin");
  } catch {
    return skip(
      "no git remote configured (origin) — local-only brains use `commonwealth promote` instead",
    );
  }

  if (!(await io.ghAvailable())) {
    return skip("the GitHub CLI (`gh`) was not found on PATH — install it to open promotion PRs");
  }

  // Resolve the selection against the CURRENT staging queue.
  const pending = await listStaged(brainDir);
  let selected: Note[];
  if ("all" in selection) {
    selected = pending;
  } else {
    selected = [];
    for (const id of selection.ids) {
      const note = pending.find((n) => n.frontmatter.id === id);
      if (!note) throw new Error(`No staged note with id "${id}" to promote`);
      selected.push(note);
    }
  }
  if (selected.length === 0) return skip("nothing staged to promote");

  // Base branch + parent commit for the promotion commit.
  const base = await io.git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const parent = await io.git(["rev-parse", "HEAD"]);
  const branch = `commonwealth/promote-${io.now()}`;

  const candidates: PromotePrNote[] = selected.map((n) => ({
    id: n.frontmatter.id,
    kind: n.frontmatter.kind,
    title: n.frontmatter.title,
    ...(n.frontmatter.source ? { source: n.frontmatter.source } : {}),
    canonPath: pathForNote(n.frontmatter.kind, n.frontmatter.id, n.frontmatter.source),
  }));

  // Secret scrub at parity with sync (#16/#98): staged notes are plain, hand-editable markdown, so
  // the capture-time gate is NOT sufficient — a secret appended to a staged file after capture would
  // otherwise be hashed into the promotion commit and pushed. Scan each note with the SAME
  // brain-configured detector the sync pre-commit scrub uses (findSecretsForBrain — one shared core
  // composition, so the two write-gates cannot disagree, including config-driven entropy/allowlist).
  const config = await loadBrainConfig(brainDir);

  // Build the promotion commit with git plumbing against a TEMP index, so the working tree and the
  // user's staging queue are never touched. hash-object writes each staged file's content as a blob
  // into the brain's object db; update-index stages it at the canonical path in the temp index.
  const tmpIndex = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-promote-")),
    "index",
  );
  const withIndex = { GIT_INDEX_FILE: tmpIndex };
  try {
    await io.git(["read-tree", parent], withIndex);
    const notes: PromotePrNote[] = []; // clean notes actually carried by the PR
    const withheld: WithheldNote[] = []; // secret-bearing notes held back, left staged locally
    for (let i = 0; i < selected.length; i += 1) {
      const stagedAbs = stagedAbsPath(brainDir, selected[i]!);
      const candidate = candidates[i]!;
      const canonRel = candidate.canonPath;

      // Scan the note's on-disk content BEFORE it is hashed into the tree. A hit withholds the note:
      // it is neither hashed nor staged, so it can never reach the branch or the remote. The staged
      // copy is left in place for the user to fix (mirrors the sync scrub's leave-in-working-tree).
      let content: string;
      try {
        content = await fs.readFile(stagedAbs, "utf8");
      } catch {
        content = ""; // unreadable/removed — nothing to scan (and nothing to promote)
      }
      const matches = findSecretsForBrain(content, config);
      if (matches.length > 0) {
        withheld.push({ ...candidate, rules: [...new Set(matches.map((m) => m.kind))] });
        continue;
      }

      // Containment guard (#77): assert the canonical path stays inside the brain before we stage it.
      resolveWithinBrain(brainDir, canonRel);
      const blob = await io.git(["hash-object", "-w", stagedAbs]);
      await io.git(
        ["update-index", "--add", "--cacheinfo", `100644,${blob},${canonRel}`],
        withIndex,
      );
      notes.push(candidate);
    }

    // Every selected note was withheld → there is nothing safe to promote. Create NO branch and NO
    // PR; return a skip so the CLI reports loudly and exits non-zero. Staged copies stay put.
    if (notes.length === 0) {
      return skip(
        `all ${withheld.length} selected note(s) withheld by the secret scan — remove the ` +
          `secret(s) and re-run: ` +
          withheld.map((w) => `${w.title} [${w.rules.join(", ")}]`).join("; "),
        withheld,
      );
    }

    const tree = await io.git(["write-tree"], withIndex);
    const identity = await identityFlags(io);
    const { title, body } = renderPr(notes, withheld.length);
    const commit = await io.git([
      ...identity,
      "commit-tree",
      tree,
      "-p",
      parent,
      "-m",
      `curate: promote ${notes.length} note(s) into canon`,
    ]);
    await io.git(["update-ref", `refs/heads/${branch}`, commit]);
    const shortSha = await io.git(["rev-parse", "--short", branch]);

    // Push the branch, then open the PR. gh infers the repo from origin.
    await io.git(["push", "origin", `refs/heads/${branch}:refs/heads/${branch}`]);
    const url = await io.gh([
      "pr",
      "create",
      "--base",
      base,
      "--head",
      branch,
      "--title",
      title,
      "--body",
      body,
    ]);

    return { branch, base, commit: shortSha, url, title, body, notes, withheld };
  } finally {
    await fs.rm(path.dirname(tmpIndex), { recursive: true, force: true });
  }
}

/**
 * Post-merge reconciliation (the second half of the staging-is-local design, ADR-0008): clear every
 * local staged copy whose id now exists in canon. After a promotion PR merges, the note is in canon
 * but the promoter's local staged copy still lingers (the branch carried adds only). The next
 * `promote`/`status` runs this sweep, which removes those now-redundant staged files. Notes still
 * absent from canon (PR closed unmerged, or never opened) are left untouched, so re-promoting works.
 *
 * Every teammate's queue is independent: this only ever touches THIS brain's local `staging/`, and
 * only the entries that already landed in canon. Returns the ids cleared, in staging-listing order.
 */
export async function reconcilePromoted(brainDir: string): Promise<string[]> {
  const canon = await listNotes(brainDir);
  const canonIds = new Set(canon.map((n) => n.frontmatter.id));
  const staged = await listStaged(brainDir);
  const cleared: string[] = [];
  for (const note of staged) {
    if (canonIds.has(note.frontmatter.id)) {
      await fs.rm(stagedAbsPath(brainDir, note));
      cleared.push(note.frontmatter.id);
    }
  }
  return cleared;
}
