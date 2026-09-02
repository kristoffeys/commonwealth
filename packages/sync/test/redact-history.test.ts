import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { redactHistory } from "../src/redact-history";
import { git, makeFixture, type Fixture } from "./helpers";

/**
 * History-purging redaction (#271, ADR-0037). The crux these tests protect: a secret that was
 * "redacted" only in the working tree still lives in a PRIOR commit's blob and in every clone —
 * `redactHistory` must scrub it from ALL history and from the shared remote, without ever printing
 * the raw literal.
 */

/** The canonical AWS example key — matches the `aws-access-key-id` pattern. */
const SECRET = "AKIAIOSFODNN7EXAMPLE";
const FRONTMATTER = "---\nid: leak\nkind: memory\ntitle: Leak\ncreated: 2026-09-02\n---\n";

let fx: Fixture;
const extraTemps: string[] = [];

beforeEach(async () => {
  fx = await makeFixture();
});
afterEach(async () => {
  await fx.cleanup();
  await Promise.all(extraTemps.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

/**
 * Reproduce the motivating leak in alice's clone: commit + push a note carrying the raw secret, then
 * a LATER commit that replaces it with the working-tree placeholder (so HEAD is clean but the raw
 * value survives in the prior blob), and push that too.
 */
async function seedLinkedLeak(): Promise<string> {
  const rel = "memory/leak.md";
  await fs.writeFile(path.join(fx.alice, rel), `${FRONTMATTER}The deploy key is ${SECRET}.\n`, "utf8");
  git(fx.alice, ["add", "-A"]);
  git(fx.alice, ["commit", "-qm", "add note with secret"]);
  git(fx.alice, ["push", "-q", "origin", "main"]);

  await fs.writeFile(
    path.join(fx.alice, rel),
    `${FRONTMATTER}The deploy key is [REDACTED:aws-access-key-id].\n`,
    "utf8",
  );
  git(fx.alice, ["add", "-A"]);
  git(fx.alice, ["commit", "-qm", "redact working tree"]);
  git(fx.alice, ["push", "-q", "origin", "main"]);
  return rel;
}

/** True if any reachable blob in `repo`'s object database contains `needle`. */
function blobSweepContains(repo: string, needle: string): boolean {
  const objs = git(repo, ["rev-list", "--objects", "--all"])
    .split("\n")
    .map((l) => l.split(" ")[0]!)
    .filter((s) => s.length > 0);
  for (const sha of objs) {
    const type = git(repo, ["cat-file", "-t", sha]);
    if (type !== "blob") continue;
    const content = execFileSync("git", ["cat-file", "-p", sha], { cwd: repo }).toString("utf8");
    if (content.includes(needle)) return true;
  }
  return false;
}

/** Clone the bare remote into a throwaway dir (tracked for cleanup) and return the checkout path. */
function freshClone(remote: string): string {
  const dir = execFileSync("mktemp", ["-d", path.join(os.tmpdir(), "commonwealth-fresh-XXXXXX")])
    .toString()
    .trim();
  extraTemps.push(dir);
  const target = path.join(dir, "clone");
  execFileSync("git", ["clone", "-q", remote, target], { stdio: "pipe" });
  return target;
}

/** Assert neither alice's full history nor a fresh clone of the remote still carries the secret. */
function assertPurgedEverywhere(): void {
  expect(git(fx.alice, ["log", "-p", "--all"])).not.toContain(SECRET);
  expect(blobSweepContains(fx.alice, SECRET)).toBe(false);

  const fresh = freshClone(fx.remote);
  expect(git(fresh, ["log", "-p", "--all"])).not.toContain(SECRET);
  expect(blobSweepContains(fresh, SECRET)).toBe(false);
}

describe("redactHistory (#271)", () => {
  it("purges a working-tree-redacted secret from all history + the remote (default engine)", async () => {
    await seedLinkedLeak();
    // Sanity: the raw secret really does survive in history despite the later placeholder commit.
    expect(git(fx.alice, ["log", "-p"])).toContain(SECRET);

    const result = await redactHistory(fx.alice, { yes: true, log: () => {} });

    expect(result.status).toBe("rewritten");
    expect(result.secretsPurged).toBeGreaterThanOrEqual(1);
    expect(result.pushed).toBe(true);
    assertPurgedEverywhere();
  });

  it("--dry-run reports the masked secret and changes nothing", async () => {
    await seedLinkedLeak();
    const headBefore = git(fx.alice, ["rev-parse", "HEAD"]);
    const remoteBefore = git(fx.remote, ["rev-parse", "main"]);

    const logs: string[] = [];
    const result = await redactHistory(fx.alice, { dryRun: true, log: (l) => logs.push(l) });
    const out = logs.join("\n");

    expect(result.status).toBe("dry-run");
    expect(result.pushed).toBe(false);
    // The masked preview is surfaced; the raw literal never is.
    expect(out).toContain("AKIA...");
    expect(out).not.toContain(SECRET);
    // Neither local HEAD nor the remote moved.
    expect(git(fx.alice, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(git(fx.remote, ["rev-parse", "main"])).toBe(remoteBefore);
  });

  it("purges via the filter-branch fallback engine", async () => {
    await seedLinkedLeak();

    const result = await redactHistory(fx.alice, {
      yes: true,
      engine: "filter-branch",
      log: () => {},
    });

    expect(result.status).toBe("rewritten");
    expect(result.engine).toBe("filter-branch");
    expect(result.pushed).toBe(true);
    assertPurgedEverywhere();
  });

  it("is a no-op on a clean brain — no rewrite, no force-push", async () => {
    const headBefore = git(fx.alice, ["rev-parse", "HEAD"]);
    const remoteBefore = git(fx.remote, ["rev-parse", "main"]);

    const result = await redactHistory(fx.alice, { yes: true, log: () => {} });

    expect(result.status).toBe("clean");
    expect(result.secretsPurged).toBe(0);
    expect(result.pushed).toBe(false);
    expect(git(fx.alice, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(git(fx.remote, ["rev-parse", "main"])).toBe(remoteBefore);
  });

  it("never prints the raw secret — only the masked preview", async () => {
    await seedLinkedLeak();
    const logs: string[] = [];

    await redactHistory(fx.alice, { yes: true, log: (l) => logs.push(l) });
    const out = logs.join("\n");

    expect(out).not.toContain(SECRET);
    expect(out).toContain("AKIA...");
  });

  it("requires the brain name to proceed; a mismatch aborts without changes", async () => {
    await seedLinkedLeak();
    const headBefore = git(fx.alice, ["rev-parse", "HEAD"]);
    const remoteBefore = git(fx.remote, ["rev-parse", "main"]);

    const aborted = await redactHistory(fx.alice, {
      confirm: async () => "not-the-brain-name",
      log: () => {},
    });
    expect(aborted.status).toBe("aborted");
    expect(aborted.pushed).toBe(false);
    expect(git(fx.alice, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(git(fx.remote, ["rev-parse", "main"])).toBe(remoteBefore);

    // Typing the brain's basename (its clone dir name) proceeds.
    const ok = await redactHistory(fx.alice, {
      confirm: async () => path.basename(fx.alice),
      log: () => {},
    });
    expect(ok.status).toBe("rewritten");
    assertPurgedEverywhere();
  });

  it("aborts (throws) when the working tree is dirty", async () => {
    await fs.writeFile(path.join(fx.alice, "memory", "dirty.md"), `${FRONTMATTER}wip\n`, "utf8");
    await expect(redactHistory(fx.alice, { yes: true, log: () => {} })).rejects.toThrow(
      /working tree is not clean/,
    );
  });

  it("aborts BEFORE any rewrite on a detached HEAD (simple-git reports current='HEAD')", async () => {
    // The secret must be present, so failure here would otherwise reach the destructive rewrite —
    // proving the guard fires early rather than being dead code (simple-git's `current` is the
    // truthy string "HEAD" on a detached HEAD, so only `status.detached` catches it).
    await seedLinkedLeak();
    const headSha = git(fx.alice, ["rev-parse", "HEAD"]);
    git(fx.alice, ["checkout", "-q", headSha]); // detach HEAD
    const remoteBefore = git(fx.remote, ["rev-parse", "main"]);

    await expect(redactHistory(fx.alice, { yes: true, log: () => {} })).rejects.toThrow(
      /detached HEAD/,
    );

    // Nothing was rewritten or pushed: the detached HEAD still points at the same commit, the
    // secret is still there (untouched), and the remote is unchanged.
    expect(git(fx.alice, ["rev-parse", "HEAD"])).toBe(headSha);
    expect(git(fx.alice, ["log", "-p"])).toContain(SECRET);
    expect(git(fx.remote, ["rev-parse", "main"])).toBe(remoteBefore);
  });
});
