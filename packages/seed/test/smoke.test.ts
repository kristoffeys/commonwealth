import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const distEntry = path.join(repoRoot, "packages", "seed", "dist", "index.js");

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

describe("commonwealth-seed built CLI (smoke)", () => {
  let fixture: string;

  beforeAll(() => {
    execFileSync("pnpm", ["-r", "build"], { cwd: repoRoot, stdio: "inherit" });

    fixture = mkdtempSync(path.join(tmpdir(), "seed-smoke-"));
    git(fixture, ["init", "-q"]);
    git(fixture, ["config", "commit.gpgsign", "false"]);
    git(fixture, ["commit", "--allow-empty", "-m", "feat: hello (#1)\n\nbody"]);
    const adrDir = path.join(fixture, "docs", "adr");
    mkdirSync(adrDir, { recursive: true });
    writeFileSync(path.join(adrDir, "0001-a.md"), "# A\n\nbody\n");
    writeFileSync(path.join(fixture, "CLAUDE.md"), "# Guide\n\nx\n");
  }, 180_000);

  it("emits a JSON array from `gather`", () => {
    const stdout = execFileSync("node", [distEntry, "gather", "--repo", fixture], {
      encoding: "utf8",
    });
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });

  it("exits 0 for `preview`", () => {
    const status = execFileSync("node", [distEntry, "preview", "--repo", fixture], {
      encoding: "utf8",
    });
    expect(typeof status).toBe("string");
  });

  it("has exactly one shebang in dist/index.js", () => {
    const content = readFileSync(distEntry, "utf8");
    const matches = content.match(/^#!\/usr\/bin\/env node$/gm) ?? [];
    expect(matches).toHaveLength(1);
    expect(content.startsWith("#!")).toBe(true);
  });
});
