import { listNotes, search, writeNote } from "@commonwealth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SyncEngine } from "../src/engine";
import { makeFixture, type Fixture } from "./helpers";

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
});
