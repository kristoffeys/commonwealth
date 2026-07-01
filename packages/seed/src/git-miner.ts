import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { NewNoteInput } from "@commons/core";

const execFileAsync = promisify(execFile);

/** Max characters retained from any single mined body. */
const BODY_CAP = 4000;

/**
 * Control-character separators so commit fields/records never collide with commit
 * content. Git's unit separator (0x1f) and record separator (0x1e) are safe: they cannot
 * appear in a commit subject or body. Built via char codes to keep source bytes clean.
 */
const FIELD_SEP = String.fromCharCode(0x1f);
const RECORD_SEP = String.fromCharCode(0x1e);

/** Options for {@link mineGitHistory}. */
export interface MineGitHistoryOptions {
  /** How many of the most-recent commits to scan. Defaults to 200. */
  maxCommits?: number;
}

/**
 * Subjects that are noise and never worth a memory note (unless they carry a #N).
 * Anchored to token boundaries so real work isn't dropped: "wip"/"bump"/"fixup" must be a
 * whole token (kept: "wipe out cache", "bumper feature", "fixups after review"); "merge
 * branch" needs a word boundary (kept: "merge branches together"); "chore(deps)" is exact.
 */
const TRIVIAL_SUBJECT = /^(?:(?:wip|fixup|bump)(?=$|[\s:!])|merge branch\b|chore\(deps\))/i;

/** Squash-merge suffix, e.g. "feat: add auth (#12)". */
const SQUASH_PR = /\(#(\d+)\)\s*$/;

/** GitHub merge-commit subject, e.g. "Merge pull request #13 from x/y". */
const MERGE_PR = /^Merge pull request #(\d+) from /;

/** Trim, collapse internal whitespace, and lowercase a title for dedupe keys. */
function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Cap a string to {@link BODY_CAP} characters after trimming. */
function capBody(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > BODY_CAP ? trimmed.slice(0, BODY_CAP) : trimmed;
}

/**
 * Parse ADR markdown files under `docs/adr/`, skipping `README.md` and `index.md`.
 * Each becomes a `decision` candidate. Ordering is stable (sorted by filename).
 */
async function mineAdrs(repoDir: string): Promise<NewNoteInput[]> {
  const adrDir = path.join(repoDir, "docs", "adr");
  let entries: string[];
  try {
    entries = await fs.readdir(adrDir);
  } catch {
    return [];
  }

  const files = entries
    .filter((name) => name.toLowerCase().endsWith(".md"))
    .filter((name) => {
      const lower = name.toLowerCase();
      return lower !== "readme.md" && lower !== "index.md";
    })
    .sort();

  const notes: NewNoteInput[] = [];
  for (const name of files) {
    const full = path.join(adrDir, name);
    let content: string;
    try {
      content = await fs.readFile(full, "utf8");
    } catch {
      continue;
    }
    const headingMatch = content.match(/^#\s+(.+)$/m);
    const title = headingMatch ? headingMatch[1]!.trim() : name.replace(/\.md$/i, "");
    notes.push({
      kind: "decision",
      title,
      body: capBody(content),
      // These are literal ADRs, so they map to `decision` notes. Whether they actually
      // stage is governed by curate's autoAdr gate downstream — that's the wizard's concern.
      tags: ["adr", "seed"],
    });
  }
  return notes;
}

/**
 * Read the most-recent commits (subject + body) as structured records. Returns `[]` if
 * the directory is not a git repo or has no commits.
 */
async function readCommits(
  repoDir: string,
  maxCommits: number,
): Promise<{ subject: string; body: string }[]> {
  const format = ["%s", "%b"].join(FIELD_SEP) + RECORD_SEP;
  let stdout: string;
  try {
    const result = await execFileAsync(
      "git",
      ["log", `--max-count=${maxCommits}`, `--pretty=format:${format}`],
      { cwd: repoDir, maxBuffer: 64 * 1024 * 1024 },
    );
    stdout = result.stdout;
  } catch {
    return [];
  }

  return stdout
    .split(RECORD_SEP)
    .map((record) => record.replace(/^\n+/, ""))
    .filter((record) => record.length > 0)
    .map((record) => {
      const [subject = "", body = ""] = record.split(FIELD_SEP);
      return { subject: subject.trim(), body: body.trim() };
    })
    .filter((record) => record.subject.length > 0);
}

/**
 * Turn commits into `memory` candidates. Captures both squash-merge subjects
 * (`… (#N)`) and GitHub merge commits (`Merge pull request #N …`); skips trivia.
 */
function minePrsAndCommits(commits: { subject: string; body: string }[]): NewNoteInput[] {
  const notes: NewNoteInput[] = [];
  const seen = new Set<string>();

  for (const { subject, body } of commits) {
    const squashMatch = subject.match(SQUASH_PR);
    const mergeMatch = subject.match(MERGE_PR);
    const prNumber = squashMatch?.[1] ?? mergeMatch?.[1] ?? null;

    // Title: strip a trailing "(#N)" from squash subjects; keep merge subjects as-is.
    const title = squashMatch ? subject.replace(SQUASH_PR, "").trim() : subject;
    if (title.length === 0) continue;

    // Skip trivia by subject, unless it carries a #N (then it's a real PR/merge).
    if (prNumber === null && TRIVIAL_SUBJECT.test(subject)) continue;

    // Skip commits with an empty/trivial body AND no #N reference.
    const hasBody = body.length > 0;
    if (prNumber === null && !hasBody) continue;

    // A raw GitHub merge commit with no description is boilerplate ("Merge pull request
    // #N from x/y") — skip it rather than echo the subject as the body. Squash subjects
    // (#N) carry real content, so keep those even without a body.
    if (mergeMatch && !hasBody) continue;

    const key = normalizeTitle(title);
    if (seen.has(key)) continue;
    seen.add(key);

    const tags = prNumber !== null ? ["git", "seed", "pr"] : ["git", "seed"];
    notes.push({
      kind: "memory",
      title,
      body: capBody(hasBody ? body : title),
      tags,
    });
  }
  return notes;
}

/**
 * Mine a git repository into candidate notes: ADRs under `docs/adr/` become `decision`
 * candidates, and notable commits / merged PRs become `memory` candidates. Deterministic
 * and offline — pure git/file parsing, stable ordering, no network or LLM. Returns `[]`
 * gracefully when `repoDir` is not a git repo or has no commits.
 *
 * @param repoDir Absolute path to the repository to mine.
 * @param opts Tuning options; see {@link MineGitHistoryOptions}.
 * @returns Candidate notes: ADR decisions first, then git memories.
 */
export async function mineGitHistory(
  repoDir: string,
  opts?: MineGitHistoryOptions,
): Promise<NewNoteInput[]> {
  const maxCommits = opts?.maxCommits ?? 200;
  const adrs = await mineAdrs(repoDir);
  const commits = await readCommits(repoDir, maxCommits);
  const gitNotes = minePrsAndCommits(commits);
  return [...adrs, ...gitNotes];
}
