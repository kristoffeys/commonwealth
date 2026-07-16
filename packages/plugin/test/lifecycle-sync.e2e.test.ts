import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initBrain, listNotes, writeNote } from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realDeps, sessionEnd, sessionStart } from "../hooks/lib.mjs";

/**
 * End-to-end daemonless lifecycle sync (ADR-0032) over REAL git: a bare remote + a working clone,
 * driven through `sessionEnd` / `sessionStart` with the PRODUCTION `realDeps()` wiring (the real
 * curate + sync binaries built by vitest globalSetup, #111). This proves the worker actually
 * commits + pushes captured notes with no daemon running, that a zero-capture session makes no
 * commit, and that a prior failed/offline push is flushed at the next SessionStart.
 */
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const curateEntry = path.join(repoRoot, "packages", "curate", "dist", "index.js");
const syncEntry = path.join(repoRoot, "packages", "sync", "dist", "index.js");

/** Run git in `cwd`, returning trimmed stdout. */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
}

/** A bare remote + a working clone with a freshly-inited brain committed and pushed. */
async function makeBrainWithRemote(root: string): Promise<{ remote: string; brain: string }> {
  const remote = path.join(root, "remote.git");
  const brain = path.join(root, "brain");
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "pipe" });
  execFileSync("git", ["clone", "-q", remote, brain], { stdio: "pipe" });
  git(brain, ["config", "user.email", "dev@example.com"]);
  git(brain, ["config", "user.name", "Dev"]);
  await initBrain(brain, { name: "e2e-brain" });
  git(brain, ["add", "-A"]);
  git(brain, ["commit", "-qm", "init brain"]);
  git(brain, ["push", "-u", "origin", "main"]);
  return { remote, brain };
}

/** Commit count on a fresh clone of `remote` (what teammates would actually pull). */
function remoteCommitCount(root: string, remote: string, name: string): number {
  const clone = path.join(root, name);
  execFileSync("git", ["clone", "-q", remote, clone], { stdio: "pipe" });
  return Number(git(clone, ["rev-list", "--count", "HEAD"]));
}

let tmp: string;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cw-lifecycle-sync-")));
  // Isolate from any real ~/.commonwealth; brain-dir env is set per test after the brain exists.
  process.env.COMMONWEALTH_CONFIG = path.join(tmp, "user-config.json");
  process.env.COMMONWEALTH_REGISTRY = path.join(tmp, "registry.json");
  delete process.env.COMMONWEALTH_BRAIN_DIR;
});

afterEach(async () => {
  delete process.env.COMMONWEALTH_CONFIG;
  delete process.env.COMMONWEALTH_REGISTRY;
  delete process.env.COMMONWEALTH_BRAIN_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("daemonless lifecycle sync — end to end (ADR-0032)", () => {
  it("commits AND pushes a captured note from the SessionEnd worker, with no daemon", async () => {
    const { remote, brain } = await makeBrainWithRemote(tmp);
    process.env.COMMONWEALTH_BRAIN_DIR = brain;
    const before = remoteCommitCount(tmp, remote, "before");

    const deps = realDeps({ curateEntry, syncEntry });
    // Stub only the LLM-facing seams (no `claude` in CI): a fixed candidate + skip the LLM curation
    // pass. Everything else — curate capture, the sync engine, git — is the real production path.
    deps.extractCandidates = async () => ({
      ok: true,
      candidates: [{ kind: "memory", title: "E2E fact", body: "a durable fact from the session" }],
    });
    delete (deps as { classifyCandidates?: unknown }).classifyCandidates;

    const result = (await sessionEnd(
      { cwd: brain, transcript_path: path.join(tmp, "none.jsonl") },
      deps,
    )) as { captured?: number; syncDeferred?: boolean };

    expect(result.captured).toBeGreaterThanOrEqual(1);
    expect(result.syncDeferred).toBeUndefined(); // the sync succeeded — nothing deferred
    // The local working copy advanced …
    expect(Number(git(brain, ["rev-list", "--count", "HEAD"]))).toBeGreaterThan(before);
    // … and the note was PUSHED: a fresh clone of the bare remote has the new commit(s).
    expect(remoteCommitCount(tmp, remote, "after")).toBeGreaterThan(before);
  }, 60_000);

  it("makes NO commit or push when the session captured zero notes", async () => {
    const { remote, brain } = await makeBrainWithRemote(tmp);
    process.env.COMMONWEALTH_BRAIN_DIR = brain;
    const before = remoteCommitCount(tmp, remote, "before");
    const headBefore = git(brain, ["rev-parse", "HEAD"]);

    const deps = realDeps({ curateEntry, syncEntry });
    deps.extractCandidates = async () => ({ ok: true, candidates: [] });

    const result = (await sessionEnd(
      { cwd: brain, transcript_path: path.join(tmp, "none.jsonl") },
      deps,
    )) as { captured?: number };

    expect(result.captured).toBe(0);
    // No pointless empty commit, and nothing pushed.
    expect(git(brain, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(remoteCommitCount(tmp, remote, "after")).toBe(before);
  }, 60_000);

  it("flushes a previously-unpushed (offline) commit at the next SessionStart", async () => {
    const { remote, brain } = await makeBrainWithRemote(tmp);
    process.env.COMMONWEALTH_BRAIN_DIR = brain;

    // Simulate a session-end whose push failed (offline): the note is committed locally but the
    // remote never got it — sync debt.
    await writeNote(brain, {
      kind: "memory",
      title: "Offline note",
      body: "captured while offline",
    });
    git(brain, ["add", "-A"]);
    git(brain, ["commit", "-qm", "offline capture (unpushed)"]);
    const before = remoteCommitCount(tmp, remote, "before");
    const beforeNotes = await listNotes(path.join(tmp, "before"), "memory");
    expect(beforeNotes.map((n) => n.body)).not.toContain("captured while offline");

    // The next SessionStart runs sync-once first, which flushes the debt (commits pending + pushes).
    const deps = realDeps({ curateEntry, syncEntry });
    await sessionStart({ cwd: brain }, deps);

    expect(remoteCommitCount(tmp, remote, "after")).toBeGreaterThan(before);
    // A fresh clone of the remote now carries the previously-unpushed note.
    const flushed = path.join(tmp, "flushed");
    execFileSync("git", ["clone", "-q", remote, flushed], { stdio: "pipe" });
    const bodies = (await listNotes(flushed, "memory")).map((n) => n.body);
    expect(bodies).toContain("captured while offline");
  }, 60_000);
});
