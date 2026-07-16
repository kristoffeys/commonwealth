import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initBrain,
  linkSources,
  listNotes,
  loadProjectAliasMap,
  persistProjectAliasMap,
  readNote,
  regenerateDerived,
  writeNote,
  type NewNoteInput,
} from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adoptProject } from "../src/adopt.js";
import { stageNote } from "../src/staging.js";

/**
 * `project adopt` (#241): promote a proven alias link into permanent `project` frontmatter in one
 * atomic commit, then retire the entry. These fixtures assert the load-bearing invariants — the
 * one-commit guarantee, the byte-identical derived output (read-time and save-time tiers agree),
 * conflict safety, the dirty-worktree refusal, non-git writes, and concurrent-capture safety.
 */

let brain: string;

beforeEach(async () => {
  brain = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-adopt-")));
  await initBrain(brain, { name: "adopt-brain" });
});
afterEach(async () => {
  await fs.rm(brain, { recursive: true, force: true });
});

function git(...args: string[]): string {
  return execFileSync("git", ["-C", brain, ...args], { encoding: "utf8" });
}
function commitAll(msg: string): void {
  git("add", "-A");
  git("-c", "user.name=Test", "-c", "user.email=t@example.com", "commit", "-q", "-m", msg);
}
function revCount(): number {
  return Number(git("rev-list", "--count", "HEAD").trim());
}
function porcelain(): string {
  return git("status", "--porcelain").trim();
}

const ws = (title: string, source: string): NewNoteInput => ({
  kind: "work-state",
  title,
  body: `Body for ${title}.`,
  source,
  fields: { status: "in-progress" },
});

/** Snapshot every derived file (COMMONWEALTH.md + all INDEX.md) as path → content. */
async function snapshotDerived(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(abs: string): Promise<void> {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        if ([".git", ".commonwealth", "index", "staging", "node_modules"].includes(e.name))
          continue;
        await walk(path.join(abs, e.name));
      } else if (e.name === "COMMONWEALTH.md" || e.name === "INDEX.md") {
        const p = path.relative(brain, path.join(abs, e.name));
        out.set(p, await fs.readFile(path.join(abs, e.name), "utf8"));
      }
    }
  }
  await walk(brain);
  return out;
}

/** Content hash of every note file, to prove a dry-run wrote nothing. */
async function noteHashes(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const n of await listNotes(brain)) {
    const raw = await fs.readFile(path.join(brain, n.path), "utf8");
    out.set(n.path, createHash("sha256").update(raw).digest("hex"));
  }
  return out;
}

/**
 * Seed a proven, already-committed two-source link: 2 work-state notes under `acme/web`, 1 under
 * `acme/api`, both linked into `acme-eng`, derived regenerated, everything committed (clean tree).
 */
async function seedLinkedAndCommitted(opts: { customer?: string } = {}): Promise<void> {
  await writeNote(brain, ws("Web cache work", "acme/web"));
  await writeNote(brain, ws("Web deploy work", "acme/web"));
  await writeNote(brain, ws("API rate limit work", "acme/api"));
  await persistProjectAliasMap(brain, (m) => {
    linkSources(m, "acme-eng", ["acme/web", "acme/api"]);
    if (opts.customer)
      m["acme-eng"] = { customer: opts.customer, sources: ["acme/web", "acme/api"] };
  });
  await regenerateDerived(brain);
  commitAll("seed: proven acme-eng link");
  expect(porcelain()).toBe(""); // clean starting point
}

describe("adoptProject — one commit, retire the entry", () => {
  it("stamps every linked note, makes ONE commit, removes the entry, keeps derived byte-identical", async () => {
    await seedLinkedAndCommitted();
    const derivedBefore = await snapshotDerived();
    const commitsBefore = revCount();

    const result = await adoptProject(brain, "acme-eng");

    expect(result.skipped).toBeUndefined();
    expect(result.adopted).toHaveLength(3);
    expect(result.committed).toBe(true);
    expect(result.entryRemoved).toBe(true);

    // Every affected note now carries the project frontmatter.
    for (const n of await listNotes(brain)) {
      expect(n.frontmatter.project).toBe("acme-eng");
    }
    // The alias entry is gone.
    expect(await loadProjectAliasMap(brain)).toEqual({});
    // Exactly one new commit, and the tree is clean afterward.
    expect(revCount()).toBe(commitsBefore + 1);
    expect(porcelain()).toBe("");
    // The commit message names the project + count.
    expect(git("log", "-1", "--pretty=%s").trim()).toBe(
      'chore(project): adopt "acme-eng" onto 3 note(s)',
    );
    // Derived output is byte-identical: the router grouped by the alias tier before, by the
    // frontmatter tier after, and both resolve to the same project.
    expect(await snapshotDerived()).toEqual(derivedBefore);
  });

  it("stamps the customer as a tag when the entry carries one", async () => {
    await seedLinkedAndCommitted({ customer: "Acme Corp" });
    const result = await adoptProject(brain, "acme-eng");
    expect(result.customer).toBe("Acme Corp");
    for (const n of await listNotes(brain)) {
      expect(n.frontmatter.tags).toContain("customer:acme-corp");
    }
  });
});

describe("adoptProject — dry-run", () => {
  it("reports per-source counts and writes nothing", async () => {
    await seedLinkedAndCommitted();
    const hashesBefore = await noteHashes();
    const commitsBefore = revCount();

    const result = await adoptProject(brain, "acme-eng", { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.adopted).toHaveLength(3);
    const web = result.perSource.find((s) => s.source === "acme/web")!;
    expect(web.adopted).toBe(2);
    const api = result.perSource.find((s) => s.source === "acme/api")!;
    expect(api.adopted).toBe(1);

    // Nothing changed: note contents, the alias map, git tree, and commit count are all untouched.
    expect(await noteHashes()).toEqual(hashesBefore);
    expect(await loadProjectAliasMap(brain)).toHaveProperty("acme-eng");
    expect(porcelain()).toBe("");
    expect(revCount()).toBe(commitsBefore);
  });

  it("reports staged matches (staging notes are never adopted)", async () => {
    await writeNote(brain, ws("Canon web note", "acme/web"));
    await stageNote(brain, ws("Staged web note", "acme/web"));
    await persistProjectAliasMap(brain, (m) => linkSources(m, "acme-eng", ["acme/web"]));
    await regenerateDerived(brain);
    commitAll("seed");

    const result = await adoptProject(brain, "acme-eng", { dryRun: true });
    expect(result.stagedMatches).toBe(1);
    expect(result.adopted).toHaveLength(1); // only the canon note is adoptable
    const web = result.perSource.find((s) => s.source === "acme/web")!;
    expect(web.staged).toBe(1);
  });
});

describe("adoptProject — conflict safety", () => {
  it("never touches a note that already declares a DIFFERENT project; reports it", async () => {
    await writeNote(brain, ws("Adoptable web note", "acme/web"));
    await writeNote(brain, { ...ws("Already other-proj", "acme/web"), project: "other-proj" });
    await persistProjectAliasMap(brain, (m) => linkSources(m, "acme-eng", ["acme/web"]));
    await regenerateDerived(brain);
    commitAll("seed");

    const result = await adoptProject(brain, "acme-eng");
    expect(result.adopted).toHaveLength(1);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.existingProject).toBe("other-proj");

    const notes = await listNotes(brain);
    const conflict = notes.find((n) => n.frontmatter.title === "Already other-proj")!;
    expect(conflict.frontmatter.project).toBe("other-proj"); // untouched
    const adopted = notes.find((n) => n.frontmatter.title === "Adoptable web note")!;
    expect(adopted.frontmatter.project).toBe("acme-eng");
  });
});

describe("adoptProject — safety refusals & keptSources", () => {
  it("refuses to run on a dirty worktree", async () => {
    await seedLinkedAndCommitted();
    await fs.writeFile(path.join(brain, "notes.txt"), "uncommitted change\n");
    expect(porcelain()).not.toBe("");

    const result = await adoptProject(brain, "acme-eng");
    expect(result.skipped).toContain("dirty");
    expect(result.committed).toBe(false);
    // Nothing was stamped.
    for (const n of await listNotes(brain)) {
      expect(n.frontmatter.project).toBeUndefined();
    }
  });

  it("skips when the project is not in the alias map", async () => {
    await seedLinkedAndCommitted();
    const result = await adoptProject(brain, "does-not-exist");
    expect(result.skipped).toContain("no project");
  });

  it("keeps the entry for sources that had zero adopted notes", async () => {
    await writeNote(brain, ws("Web note", "acme/web"));
    // acme/empty is linked but has no notes.
    await persistProjectAliasMap(brain, (m) =>
      linkSources(m, "acme-eng", ["acme/web", "acme/empty"]),
    );
    await regenerateDerived(brain);
    commitAll("seed");

    const result = await adoptProject(brain, "acme-eng");
    expect(result.adopted).toHaveLength(1);
    expect(result.entryRemoved).toBe(false);
    expect(result.keptSources).toEqual(["acme/empty"]);
    // The map still carries the residual link, minus the adopted source.
    expect((await loadProjectAliasMap(brain))["acme-eng"]).toEqual({ sources: ["acme/empty"] });
  });

  it("writes without committing on a non-git brain", async () => {
    await writeNote(brain, ws("Web note", "acme/web"));
    await persistProjectAliasMap(brain, (m) => linkSources(m, "acme-eng", ["acme/web"]));
    await regenerateDerived(brain);
    await fs.rm(path.join(brain, ".git"), { recursive: true, force: true });

    const result = await adoptProject(brain, "acme-eng");
    expect(result.committed).toBe(false);
    expect(result.adopted).toHaveLength(1);
    const [note] = await listNotes(brain);
    expect(note!.frontmatter.project).toBe("acme-eng"); // written, just not committed
  });
});

describe("adoptProject — legacy-brain compatibility (#241)", () => {
  /**
   * Simulate a pre-existing brain: strip the runtime-state entries from `.gitignore` (they postdate
   * such brains), so `.commonwealth/sync.lock`/`sync.pid` are NOT ignored — exactly the condition
   * that made adopt refuse with a misleading "dirty" error before the exclusion fix.
   */
  async function makeLegacy(): Promise<void> {
    const gi = path.join(brain, ".gitignore");
    const kept = (await fs.readFile(gi, "utf8"))
      .split("\n")
      .filter(
        (l) => l.trim() !== ".commonwealth/sync.lock" && l.trim() !== ".commonwealth/sync.pid",
      )
      .join("\n");
    await fs.writeFile(gi, kept);
    commitAll("legacy: drop runtime-state gitignore entries");
    expect(await fs.readFile(gi, "utf8")).not.toContain("sync.lock");
  }

  it("succeeds on a legacy brain with a pre-existing (stale) sync.lock; lock stays out of the commit", async () => {
    await seedLinkedAndCommitted();
    await makeLegacy();
    // A leftover lock from a crashed process (stale pid → reclaimable), plus a daemon pid file.
    await fs.writeFile(path.join(brain, ".commonwealth", "sync.lock"), "999999\n");
    await fs.writeFile(path.join(brain, ".commonwealth", "sync.pid"), "999998\n");
    const commitsBefore = revCount();

    const result = await adoptProject(brain, "acme-eng");

    expect(result.skipped).toBeUndefined();
    expect(result.adopted).toHaveLength(3);
    expect(result.committed).toBe(true);
    expect(revCount()).toBe(commitsBefore + 1);
    for (const n of await listNotes(brain)) expect(n.frontmatter.project).toBe("acme-eng");
    // The runtime lock/pid never entered the commit.
    const tree = git("ls-tree", "-r", "HEAD", "--name-only");
    expect(tree).not.toContain(".commonwealth/sync.lock");
    expect(tree).not.toContain(".commonwealth/sync.pid");
  });

  it("still refuses on a legacy brain when there is GENUINE dirt", async () => {
    await seedLinkedAndCommitted();
    await makeLegacy();
    await fs.writeFile(path.join(brain, ".commonwealth", "sync.lock"), "999999\n"); // disposable
    await fs.writeFile(path.join(brain, "real-change.txt"), "genuine uncommitted work\n"); // real dirt

    const result = await adoptProject(brain, "acme-eng");
    expect(result.skipped).toContain("dirty");
    for (const n of await listNotes(brain)) expect(n.frontmatter.project).toBeUndefined();
  });
});

describe("adoptProject — concurrent-capture smoke", () => {
  it("a capture landing mid-adopt is neither lost nor corrupted (snapshot semantics)", async () => {
    await seedLinkedAndCommitted();
    // Drop git so the fresh capture's brand-new (uncommitted) file can't trip the dirty-worktree
    // refusal — this test is about the snapshot + atomic-write invariant, not the git gate.
    await fs.rm(path.join(brain, ".git"), { recursive: true, force: true });

    // Race a fresh capture against the adoption. writeNote is lock-free and never touches git; adopt
    // operates on a snapshot listing, so the new note either makes the snapshot (and is stamped) or
    // doesn't (keeps its own stamping path) — but is never lost or corrupted.
    const [result, fresh] = await Promise.all([
      adoptProject(brain, "acme-eng"),
      writeNote(brain, ws("Concurrent web note", "acme/web")),
    ]);

    expect(result.skipped).toBeUndefined();
    // The fresh note's file exists and parses cleanly (no partial/corrupt write).
    const reread = await readNote(brain, fresh.path);
    expect(reread.frontmatter.title).toBe("Concurrent web note");
    // The pre-existing snapshot notes were all stamped.
    const preExisting = (await listNotes(brain)).filter(
      (n) => n.frontmatter.id !== fresh.frontmatter.id,
    );
    for (const n of preExisting) expect(n.frontmatter.project).toBe("acme-eng");
  });
});
