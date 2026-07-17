import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  initBrain,
  listNotes,
  loadBrainConfig,
  saveBrainConfig,
  type NewNoteInput,
} from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approve } from "../src/review.js";
import { listStaged, stageNote, stagedAbsPath } from "../src/staging.js";
import {
  defaultPromotePrIo,
  promoteViaPr,
  reconcilePromoted,
  type PromotePrIo,
} from "../src/promote-pr.js";

/**
 * `promote --pr` (#215): curation as a brain-repo pull request. The load-bearing invariants under
 * test are the staging-is-local design (ADR-0008): the PR branch carries CANON ADDS ONLY, the
 * promoter's staged copies survive until a POST-MERGE reconciliation sweep clears the ones whose ids
 * landed in canon, and a closed (unmerged) PR leaves staging fully intact so re-promoting is trivial.
 * Git runs for real against a local bare remote; `gh` is stubbed (argv recorded, fake URL returned).
 */

let brain: string;
let remote: string;
let scratch: string;

/** git in the brain (throws on non-zero). */
function git(...args: string[]): string {
  return execFileSync("git", ["-C", brain, ...args], { encoding: "utf8" }).trim();
}
/** git in an arbitrary repo. */
function gitAt(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

const mem = (title: string, source?: string): NewNoteInput => ({
  kind: "memory",
  title,
  body: `Body for ${title}.`,
  ...(source ? { source } : {}),
});

/** A stubbed-gh IO: real git in the brain, `gh` recorded and faked. */
function stubbedIo(
  record: { calls: string[][] },
  opts: { gh?: boolean; url?: string } = {},
): PromotePrIo {
  const real = defaultPromotePrIo(brain);
  return {
    git: real.git,
    now: () => 1234567890,
    ghAvailable: async () => opts.gh !== false,
    gh: async (args) => {
      record.calls.push(args);
      return opts.url ?? "https://github.com/acme/brain/pull/42";
    },
  };
}

beforeEach(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "commonwealth-promote-pr-")));
  brain = path.join(scratch, "brain");
  remote = path.join(scratch, "remote.git");
  await initBrain(brain, { name: "promote-brain" });
  // A bare remote, wired as origin, with the scaffold's main pushed to it.
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git("remote", "add", "origin", remote);
  git("push", "-q", "origin", "main");
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

describe("promote --pr", () => {
  it("branches, commits canon adds, pushes, and files a PR with a body listing each note", async () => {
    const a = await stageNote(brain, mem("First fact", "acme/widgets"));
    const b = await stageNote(brain, mem("Second fact"));
    const record = { calls: [] as string[][] };

    const result = await promoteViaPr(brain, { all: true }, stubbedIo(record));

    expect(result.skipped).toBeUndefined();
    expect(result.base).toBe("main");
    expect(result.branch).toBe("commonwealth/promote-1234567890");
    expect(result.url).toBe("https://github.com/acme/brain/pull/42");
    expect(result.notes).toHaveLength(2);

    // gh was called exactly once: `pr create --base main --head <branch> --title .. --body ..`.
    expect(record.calls).toHaveLength(1);
    const argv = record.calls[0]!;
    expect(argv.slice(0, 2)).toEqual(["pr", "create"]);
    const flag = (name: string): string => argv[argv.indexOf(name) + 1]!;
    expect(flag("--base")).toBe("main");
    expect(flag("--head")).toBe(result.branch);
    const body = flag("--body");
    // Body lists each note's kind, title, source, id and canonical path.
    expect(body).toContain("First fact");
    expect(body).toContain("acme/widgets");
    expect(body).toContain(`acme-widgets/memory/${a.frontmatter.id}.md`);
    expect(body).toContain("Second fact");
    expect(body).toContain(`memory/${b.frontmatter.id}.md`);
    expect(body).toContain("ADR-0003");
    expect(body).toContain("ADR-0008");

    // The branch was pushed to the remote and adds the canon files; main does NOT have them yet.
    const remoteBranches = gitAt(remote, "branch", "--list", result.branch);
    expect(remoteBranches).toContain(result.branch);
    const branchTree = git("ls-tree", "-r", "--name-only", result.branch);
    expect(branchTree).toContain(`acme-widgets/memory/${a.frontmatter.id}.md`);
    expect(branchTree).toContain(`memory/${b.frontmatter.id}.md`);
    const mainTree = git("ls-tree", "-r", "--name-only", "main");
    expect(mainTree).not.toContain(`memory/${b.frontmatter.id}.md`);

    // Staging is untouched (adds-only branch, gitignored local queue): both copies survive.
    const pending = await listStaged(brain);
    expect(pending.map((n) => n.frontmatter.id).sort()).toEqual(
      [a.frontmatter.id, b.frontmatter.id].sort(),
    );
    // And the working tree is undisturbed (plumbing built the commit off a temp index).
    expect(git("status", "--porcelain")).toBe("");
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  it("promotes only the selected ids", async () => {
    const a = await stageNote(brain, mem("Keep staged"));
    const b = await stageNote(brain, mem("Promote me"));
    const record = { calls: [] as string[][] };

    const result = await promoteViaPr(brain, { ids: [b.frontmatter.id] }, stubbedIo(record));

    expect(result.notes.map((n) => n.id)).toEqual([b.frontmatter.id]);
    const branchTree = git("ls-tree", "-r", "--name-only", result.branch);
    expect(branchTree).toContain(`memory/${b.frontmatter.id}.md`);
    expect(branchTree).not.toContain(`memory/${a.frontmatter.id}.md`);
  });

  it("throws on an id that is not in the staging queue", async () => {
    await stageNote(brain, mem("Present"));
    await expect(
      promoteViaPr(brain, { ids: ["not-a-real-id"] }, stubbedIo({ calls: [] })),
    ).rejects.toThrow(/No staged note with id/);
  });

  describe("post-merge reconciliation (ADR-0008)", () => {
    it("clears staged copies whose ids landed in canon after the PR merges", async () => {
      const a = await stageNote(brain, mem("Merged fact", "acme/widgets"));
      const b = await stageNote(brain, mem("Also merged"));
      const record = { calls: [] as string[][] };
      const result = await promoteViaPr(brain, { all: true }, stubbedIo(record));

      // Simulate the PR merging on the host, then the promoter pulling: fast-forward main to the
      // promotion commit (its parent IS main) and push, mirroring "merge in the bare repo, pull".
      git("merge", "--ff-only", result.branch);
      git("push", "-q", "origin", "main");

      // Before the sweep: the notes are in canon AND still linger in the local staging queue.
      const canonIds = (await listNotes(brain)).map((n) => n.frontmatter.id);
      expect(canonIds).toContain(a.frontmatter.id);
      expect(canonIds).toContain(b.frontmatter.id);
      expect((await listStaged(brain)).map((n) => n.frontmatter.id).sort()).toEqual(
        [a.frontmatter.id, b.frontmatter.id].sort(),
      );

      const cleared = await reconcilePromoted(brain);
      expect(cleared.sort()).toEqual([a.frontmatter.id, b.frontmatter.id].sort());
      expect(await listStaged(brain)).toHaveLength(0);
      // Canon is unaffected by the sweep.
      expect((await listNotes(brain)).map((n) => n.frontmatter.id).sort()).toEqual(
        [a.frontmatter.id, b.frontmatter.id].sort(),
      );
    });

    it("leaves a staged copy in place when its note is NOT yet in canon (no-op sweep)", async () => {
      const a = await stageNote(brain, mem("Still pending"));
      const cleared = await reconcilePromoted(brain);
      expect(cleared).toEqual([]);
      expect((await listStaged(brain)).map((n) => n.frontmatter.id)).toEqual([a.frontmatter.id]);
    });
  });

  describe("closed (unmerged) PR", () => {
    it("leaves staging intact and lets the note be re-promoted", async () => {
      const a = await stageNote(brain, mem("Rejected in review"));
      const record = { calls: [] as string[][] };
      const first = await promoteViaPr(brain, { all: true }, stubbedIo(record));

      // Simulate closing the PR without merging: the branch is discarded on the remote and locally,
      // and main never advances — nothing enters canon.
      git("push", "-q", "origin", "--delete", first.branch);
      git("branch", "-D", first.branch);

      // The sweep clears nothing (canon is still empty), and the staged copy survives.
      expect(await reconcilePromoted(brain)).toEqual([]);
      expect(await listNotes(brain)).toHaveLength(0);
      expect((await listStaged(brain)).map((n) => n.frontmatter.id)).toEqual([a.frontmatter.id]);

      // Re-promoting works: a fresh branch, still carrying the same staged note.
      const io2 = stubbedIo(record);
      io2.now = () => 1999999999;
      const second = await promoteViaPr(brain, { all: true }, io2);
      expect(second.skipped).toBeUndefined();
      expect(second.branch).toBe("commonwealth/promote-1999999999");
      expect(second.notes.map((n) => n.id)).toEqual([a.frontmatter.id]);
    });
  });

  describe("secret scrub (parity with the sync pre-commit scrub, #98/#16)", () => {
    // The AWS example key: matches `aws-access-key-id` on its own, and the assignment line matches
    // `generic-secret-assignment` too. Appended AFTER capture, the way a hand edit slips one in.
    const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

    it("withholds a staged note that grew a secret; the clean sibling still promotes", async () => {
      const dirty = await stageNote(brain, mem("Has a leaked key"));
      const clean = await stageNote(brain, mem("Clean fact"));
      // The verifier's exact repro: append a credential to the staged markdown after it was captured.
      await fs.appendFile(stagedAbsPath(brain, dirty), `\naws_secret_access_key = ${AWS_KEY}\n`);
      const record = { calls: [] as string[][] };

      const result = await promoteViaPr(brain, { all: true }, stubbedIo(record));

      // A PR is still opened for the clean note; the secret-bearing note is held back.
      expect(result.skipped).toBeUndefined();
      expect(result.notes.map((n) => n.id)).toEqual([clean.frontmatter.id]);
      // The report names the withheld note AND the rule(s) it hit (loud, like the sync scrub).
      expect(result.withheld.map((w) => w.id)).toEqual([dirty.frontmatter.id]);
      expect(result.withheld[0]!.title).toBe("Has a leaked key");
      expect(result.withheld[0]!.rules).toContain("aws-access-key-id");

      // The pushed branch adds the clean note but NOT the withheld one...
      const branchTree = git("ls-tree", "-r", "--name-only", result.branch);
      expect(branchTree).toContain(`memory/${clean.frontmatter.id}.md`);
      expect(branchTree).not.toContain(`memory/${dirty.frontmatter.id}.md`);
      // ...and the credential appears in NO blob reachable from the branch (nothing rode along).
      const files = branchTree.split("\n").filter((f) => f.length > 0);
      const blobDump = files.map((f) => git("show", `${result.branch}:${f}`)).join("\n");
      expect(blobDump).not.toContain(AWS_KEY);

      // The PR body flags the incomplete batch so the reviewer knows a note was withheld.
      const argv = record.calls[0]!;
      const body = argv[argv.indexOf("--body") + 1]!;
      expect(body).toContain("1 withheld by secret scan");

      // The withheld note is left staged locally (fix-and-re-promote), never silently dropped.
      expect((await listStaged(brain)).map((n) => n.frontmatter.id)).toContain(
        dirty.frontmatter.id,
      );
    });

    it("creates no branch and signals a skip when EVERY selected note is withheld", async () => {
      const a = await stageNote(brain, mem("Only a secret here"));
      await fs.appendFile(stagedAbsPath(brain, a), `\naws_secret_access_key = ${AWS_KEY}\n`);
      const record = { calls: [] as string[][] };

      const result = await promoteViaPr(brain, { all: true }, stubbedIo(record));

      // Skip (→ the CLI exits non-zero); the withheld note is reported.
      expect(result.skipped).toMatch(/withheld by the secret scan/i);
      expect(result.branch).toBe("");
      expect(result.withheld.map((w) => w.id)).toEqual([a.frontmatter.id]);
      // gh was never invoked and NO promotion branch exists on the remote or locally.
      expect(record.calls).toHaveLength(0);
      expect(gitAt(remote, "branch", "--list", "commonwealth/*")).toBe("");
      expect(git("branch", "--list", "commonwealth/*")).toBe("");
      // The note is left staged so it can be fixed and re-promoted.
      expect((await listStaged(brain)).map((n) => n.frontmatter.id)).toEqual([a.frontmatter.id]);
    });

    it("honors the brain's secretScan allowlist (config parity with sync's scanOptions)", async () => {
      const a = await stageNote(brain, mem("Carries an allowlisted token"));
      // A bare AWS key that the scanner flags by default...
      await fs.appendFile(stagedAbsPath(brain, a), `\n${AWS_KEY}\n`);
      // ...but the brain allowlists that exact value, so the scan must let it through — the SAME
      // config-driven semantics the sync scrub gets via scanOptions(loadBrainConfig()).
      const config = await loadBrainConfig(brain);
      await saveBrainConfig(brain, {
        ...config,
        secretScan: { ...config.secretScan, allowlist: [AWS_KEY] },
      });
      const record = { calls: [] as string[][] };

      const result = await promoteViaPr(brain, { all: true }, stubbedIo(record));

      expect(result.skipped).toBeUndefined();
      expect(result.withheld).toHaveLength(0);
      expect(result.notes.map((n) => n.id)).toEqual([a.frontmatter.id]);
      const branchTree = git("ls-tree", "-r", "--name-only", result.branch);
      expect(branchTree).toContain(`memory/${a.frontmatter.id}.md`);
    });
  });

  describe("graceful refusals", () => {
    it("skips with a clear message when the brain has no git remote", async () => {
      git("remote", "remove", "origin");
      await stageNote(brain, mem("Local-only fact"));
      const result = await promoteViaPr(brain, { all: true }, stubbedIo({ calls: [] }));
      expect(result.skipped).toMatch(/no git remote/i);
    });

    it("skips with a clear message when the `gh` CLI is unavailable", async () => {
      await stageNote(brain, mem("Needs gh"));
      const record = { calls: [] as string[][] };
      const result = await promoteViaPr(brain, { all: true }, stubbedIo(record, { gh: false }));
      expect(result.skipped).toMatch(/gh/);
      expect(record.calls).toHaveLength(0); // gh was never invoked
    });

    it("skips when there is nothing staged to promote", async () => {
      const result = await promoteViaPr(brain, { all: true }, stubbedIo({ calls: [] }));
      expect(result.skipped).toMatch(/nothing staged/i);
    });
  });

  describe("terminal promote regression", () => {
    it("approve() still moves a staged note straight into canon, staging cleared", async () => {
      const a = await stageNote(brain, mem("Terminal promote"));
      const canonPath = await approve(brain, a.frontmatter.id);
      expect(canonPath).toBe(`memory/${a.frontmatter.id}.md`);
      expect((await listNotes(brain)).map((n) => n.frontmatter.id)).toContain(a.frontmatter.id);
      expect(await listStaged(brain)).toHaveLength(0);
      // No PR branch was created and the remote is untouched.
      expect(gitAt(remote, "branch", "--list", "commonwealth/*")).toBe("");
    });
  });
});
