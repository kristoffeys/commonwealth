import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { mineGitHistory } from "../src/git-miner.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

function commit(cwd: string, message: string): void {
  // Use --allow-empty so we can create commits by subject/body alone.
  git(cwd, ["commit", "--allow-empty", "-m", message]);
}

describe("mineGitHistory", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), "seed-git-"));
    git(repo, ["init", "-q"]);
    git(repo, ["config", "commit.gpgsign", "false"]);

    // A real feature commit with a body and a squash-merge #N.
    commit(repo, "feat: add JWT auth (#12)\n\nUses short-lived access tokens plus refresh.");
    // A GitHub merge-commit WITH a description — kept.
    commit(repo, "Merge pull request #13 from x/y\n\nAdds the billing dashboard.");
    // A GitHub merge-commit with NO body — boilerplate, should be excluded.
    commit(repo, "Merge pull request #99 from foo/bar");
    // Trivia — should be excluded.
    commit(repo, "wip");
    commit(repo, "bump version to 2.0");
    commit(repo, "fixup! earlier commit");
    // Dependency bump — should be excluded.
    commit(repo, "chore(deps): bump lodash from 1 to 2");
    // Boundary cases: real commits that merely START with trivia letters — must be KEPT.
    commit(repo, "wipe out stale cache\n\nRemoves the legacy cache layer.");
    commit(repo, "bumper sticker feature added\n\nA fun UI easter egg.");

    // An ADR file.
    const adrDir = path.join(repo, "docs", "adr");
    mkdirSync(adrDir, { recursive: true });
    writeFileSync(
      path.join(adrDir, "0001-use-postgres.md"),
      "# Use Postgres\n\nWe pick Postgres over MySQL for JSONB.\n",
    );
    // README should be skipped.
    writeFileSync(path.join(adrDir, "README.md"), "# Index of ADRs\n\nnot a decision\n");
  });

  it("turns an ADR into a decision note titled from its heading", async () => {
    const notes = await mineGitHistory(repo);
    const decisions = notes.filter((n) => n.kind === "decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.title).toBe("Use Postgres");
    expect(decisions[0]!.tags).toEqual(["adr", "seed"]);
    expect(decisions[0]!.body).toContain("Postgres over MySQL");
  });

  it("captures the feat and the PR as memory notes with stripped titles", async () => {
    const notes = await mineGitHistory(repo);
    const memories = notes.filter((n) => n.kind === "memory");
    const titles = memories.map((n) => n.title);

    expect(titles).toContain("feat: add JWT auth");
    expect(titles).toContain("Merge pull request #13 from x/y");

    const feat = memories.find((n) => n.title === "feat: add JWT auth")!;
    expect(feat.tags).toContain("pr");
    expect(feat.body).toContain("short-lived access tokens");
  });

  it("excludes trivia but keeps real commits that merely share a prefix", async () => {
    const notes = await mineGitHistory(repo);
    const titles = notes.map((n) => n.title);
    // Trivia dropped.
    expect(titles).not.toContain("wip");
    expect(titles).not.toContain("bump version to 2.0");
    expect(titles).not.toContain("fixup! earlier commit");
    expect(titles.some((t) => t.toLowerCase().startsWith("chore(deps)"))).toBe(false);
    // Boilerplate merge with no body dropped; merge WITH a body kept.
    expect(titles).not.toContain("Merge pull request #99 from foo/bar");
    expect(titles).toContain("Merge pull request #13 from x/y");
    // Boundary: real work starting with trivia letters is kept (word-boundary anchored).
    expect(titles).toContain("wipe out stale cache");
    expect(titles).toContain("bumper sticker feature added");
  });

  it("is stable across two calls", async () => {
    const first = await mineGitHistory(repo);
    const second = await mineGitHistory(repo);
    expect(second).toEqual(first);
  });

  it("returns [] for a non-git directory", async () => {
    const notGit = mkdtempSync(path.join(tmpdir(), "seed-nogit-"));
    const notes = await mineGitHistory(notGit);
    expect(notes).toEqual([]);
  });
});
