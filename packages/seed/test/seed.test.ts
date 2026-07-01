import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { gatherCandidates } from "../src/seed.js";

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

describe("gatherCandidates", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), "seed-gather-"));
    git(repo, ["init", "-q"]);
    git(repo, ["config", "commit.gpgsign", "false"]);
    git(repo, ["commit", "--allow-empty", "-m", "feat: ship thing (#7)\n\nDetails here."]);

    const adrDir = path.join(repo, "docs", "adr");
    mkdirSync(adrDir, { recursive: true });
    writeFileSync(path.join(adrDir, "0001-x.md"), "# Decide X\n\nBecause.\n");

    writeFileSync(path.join(repo, "CLAUDE.md"), "# Guide\n\nRead docs.\n");
  });

  it("combines all sources with correct bySource counts", async () => {
    const { candidates, bySource } = await gatherCandidates(repo);
    expect(bySource).toEqual({ adr: 1, git: 1, config: 1 });
    expect(candidates).toHaveLength(3);
  });

  it("orders candidates adr → git → config", async () => {
    const { candidates } = await gatherCandidates(repo);
    expect(candidates[0]!.tags).toContain("adr");
    expect(candidates[1]!.tags).toContain("git");
    expect(candidates[2]!.tags).toContain("config");
  });

  it("is deterministic across two calls", async () => {
    const first = await gatherCandidates(repo);
    const second = await gatherCandidates(repo);
    expect(second).toEqual(first);
  });
});
