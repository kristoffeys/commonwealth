import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initBrain } from "@commonwealth/core";

/** Run a git command in `cwd`, returning trimmed stdout. */
export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
}

/** Set the identity a clone commits under (required for commits to succeed in CI). */
export function setIdentity(dir: string, name: string): void {
  git(dir, ["config", "user.email", `${name}@example.com`]);
  git(dir, ["config", "user.name", name]);
}

export interface Fixture {
  /** Absolute path to the bare remote. */
  remote: string;
  /** Absolute path to alice's working copy. */
  alice: string;
  /** Absolute path to bob's working copy. */
  bob: string;
  /** Remove all temp dirs. */
  cleanup: () => Promise<void>;
}

/**
 * Build a realistic multiplayer fixture: a bare remote plus two clones (alice, bob).
 * Alice inits the brain, commits, and pushes; bob clones it. Both identities are set.
 */
export async function makeFixture(): Promise<Fixture> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-sync-")));
  const remote = path.join(root, "remote.git");
  const alice = path.join(root, "alice");
  const bob = path.join(root, "bob");

  execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "pipe" });

  // Alice: clone, init brain, commit, push.
  execFileSync("git", ["clone", "-q", remote, alice], { stdio: "pipe" });
  setIdentity(alice, "alice");
  await initBrain(alice, { name: "test-brain" });
  git(alice, ["add", "-A"]);
  git(alice, ["commit", "-qm", "init brain"]);
  git(alice, ["push", "-u", "origin", "main"]);

  // Bob: clone the now-populated remote.
  execFileSync("git", ["clone", "-q", remote, bob], { stdio: "pipe" });
  setIdentity(bob, "bob");

  return {
    remote,
    alice,
    bob,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

/** Recursively list repo-relative markdown paths under `dir` (excluding `.git`). */
export async function listMarkdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string): Promise<void> {
    const entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true });
    for (const e of entries) {
      if (e.name === ".git") continue;
      const childRel = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) await walk(childRel);
      else if (e.name.endsWith(".md")) out.push(childRel);
    }
  }
  await walk("");
  return out.sort();
}
