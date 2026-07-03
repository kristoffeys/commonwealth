import { promises as fs } from "node:fs";
import path from "node:path";
import { listNotes, search, writeNote } from "@commonwealth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SyncEngine } from "../src/engine";
import { git, makeFixture, type Fixture } from "./helpers";

let fx: Fixture;

beforeEach(async () => {
  fx = await makeFixture();
});
afterEach(async () => {
  await fx.cleanup();
});

describe("SyncEngine.syncOnce convergence", () => {
  it("propagates a note from alice to bob and back (both + remote converge)", async () => {
    const aliceEngine = new SyncEngine(fx.alice);
    const bobEngine = new SyncEngine(fx.bob);

    // Alice writes and syncs → note is on the remote.
    await writeNote(fx.alice, { kind: "memory", title: "Alice fact", body: "from alice" });
    const aSummary = await aliceEngine.syncOnce();
    expect(aSummary.committed).toBe(true);
    expect(aSummary.pushed).toBe(true);
    expect(aSummary.conflicts).toHaveLength(0);

    // Bob syncs → pulls alice's note.
    await bobEngine.syncOnce();
    let bobNotes = await listNotes(fx.bob, "memory");
    expect(bobNotes.map((n) => n.body)).toContain("from alice");

    // Bob writes and syncs → note goes to the remote.
    await writeNote(fx.bob, { kind: "memory", title: "Bob fact", body: "from bob" });
    await bobEngine.syncOnce();

    // Alice syncs → pulls bob's note; both clones now hold both notes.
    await aliceEngine.syncOnce();
    const aliceNotes = await listNotes(fx.alice, "memory");
    bobNotes = await listNotes(fx.bob, "memory");
    expect(aliceNotes.map((n) => n.body).sort()).toEqual(["from alice", "from bob"]);
    expect(bobNotes.map((n) => n.body).sort()).toEqual(["from alice", "from bob"]);
  });

  it("atomic notes with distinct ids never conflict (union merge)", async () => {
    const aliceEngine = new SyncEngine(fx.alice);
    const bobEngine = new SyncEngine(fx.bob);

    // Both write DIFFERENT notes before syncing — the common, conflict-free path.
    await writeNote(fx.alice, { kind: "memory", title: "A insight", body: "alice body" });
    await writeNote(fx.bob, { kind: "memory", title: "B insight", body: "bob body" });

    // Sequenced syncs: alice pushes first, bob rebases on top.
    const a = await aliceEngine.syncOnce();
    const b = await bobEngine.syncOnce();
    expect(a.conflicts).toHaveLength(0);
    expect(b.conflicts).toHaveLength(0);

    // Alice pulls bob's note back down.
    await aliceEngine.syncOnce();

    for (const dir of [fx.alice, fx.bob]) {
      const bodies = (await listNotes(dir, "memory")).map((n) => n.body).sort();
      expect(bodies).toEqual(["alice body", "bob body"]);
    }
  });

  it("rebuilds the derived index after pull (search finds a pulled note)", async () => {
    const aliceEngine = new SyncEngine(fx.alice);
    const bobEngine = new SyncEngine(fx.bob);

    await writeNote(fx.alice, {
      kind: "memory",
      title: "Peculiar keyword note",
      body: "contains zorptastic marker",
    });
    await aliceEngine.syncOnce();

    await bobEngine.syncOnce();

    // buildIndex ran inside syncOnce, so search over bob's copy finds the pulled note.
    const results = await search(fx.bob, "zorptastic");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.title).toBe("Peculiar keyword note");
  });

  it("skips (no-op) when another live process holds the sync lock (#100)", async () => {
    const engine = new SyncEngine(fx.alice);
    // Simulate another live process mid-sync: a lock file naming a live pid (this test process).
    const lock = path.join(fx.alice, ".commonwealth", "sync.lock");
    await fs.mkdir(path.dirname(lock), { recursive: true });
    await fs.writeFile(lock, `${process.pid}\n`, "utf8");

    await writeNote(fx.alice, { kind: "memory", title: "Blocked", body: "should not commit yet" });
    const before = git(fx.alice, ["rev-list", "--count", "HEAD"]);

    const summary = await engine.syncOnce();
    // Contended → this pass did nothing (no commit/push), rather than racing the lock holder.
    expect(summary).toEqual({
      committed: false,
      pulled: false,
      pushed: false,
      conflicts: [],
      secretsBlocked: [],
    });
    expect(git(fx.alice, ["rev-list", "--count", "HEAD"])).toBe(before);

    // Release the lock → the next sync commits normally.
    await fs.rm(lock, { force: true });
    expect((await engine.syncOnce()).committed).toBe(true);
  });

  it("recovers a rebase stranded by a prior crashed pass, then converges (#100)", async () => {
    const aliceEngine = new SyncEngine(fx.alice);
    const bobEngine = new SyncEngine(fx.bob);

    const seeded = await writeNote(fx.alice, {
      kind: "memory",
      title: "Shared fact",
      body: "original",
    });
    await aliceEngine.syncOnce();
    await bobEngine.syncOnce();
    const rel = seeded.path;

    // Both edit the same file; alice pushes first.
    await fs.writeFile(path.join(fx.alice, rel), `${await header(fx.alice, rel)}\nALICE\n`, "utf8");
    git(fx.alice, ["commit", "-aqm", "alice edit"]);
    await aliceEngine.syncOnce();

    await fs.writeFile(path.join(fx.bob, rel), `${await header(fx.bob, rel)}\nBOB\n`, "utf8");
    git(fx.bob, ["commit", "-aqm", "bob edit"]);

    // Simulate a CRASH mid-rebase: manually start a rebase that conflicts and leave it stranded.
    git(fx.bob, ["fetch", "origin"]);
    try {
      git(fx.bob, ["rebase", "origin/main"]);
    } catch {
      /* expected conflict — bob is now stranded mid-rebase */
    }
    await expect(fs.access(path.join(fx.bob, ".git", "rebase-merge"))).resolves.toBeUndefined();

    // The engine must detect the stranded rebase, abort it, and complete a clean sync.
    const summary = await bobEngine.syncOnce();
    await expect(fs.access(path.join(fx.bob, ".git", "rebase-merge"))).rejects.toBeTruthy();
    expect(git(fx.bob, ["status", "--porcelain"])).toBe("");
    expect(summary.pushed).toBe(true);
    // Both versions survive (resolved as siblings after recovery).
    const bodies = (await listNotes(fx.bob, "memory")).map((n) => n.body).join("\n");
    expect(bodies).toContain("ALICE");
    expect(bodies).toContain("BOB");
  });
});

/** Read a note file's frontmatter block (through the closing `---`) to rewrite its body in-place. */
async function header(dir: string, rel: string): Promise<string> {
  const raw = await fs.readFile(path.join(dir, rel), "utf8");
  const end = raw.indexOf("\n---", 3);
  return raw.slice(0, raw.indexOf("\n", end + 1) + 1);
}
