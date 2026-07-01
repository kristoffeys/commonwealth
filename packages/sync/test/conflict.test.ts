import { promises as fs } from "node:fs";
import path from "node:path";
import { listNotes, writeNote } from "@commonwealth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SyncEngine } from "../src/engine";
import { git, listMarkdown, makeFixture, type Fixture } from "./helpers";

let fx: Fixture;

beforeEach(async () => {
  fx = await makeFixture();
});
afterEach(async () => {
  await fx.cleanup();
});

/** Overwrite the body of an existing note file, preserving its frontmatter block. */
async function editNoteBody(dir: string, relPath: string, newBody: string): Promise<void> {
  const abs = path.join(dir, relPath);
  const raw = await fs.readFile(abs, "utf8");
  const end = raw.indexOf("\n---", 3);
  const fmEnd = raw.indexOf("\n", end + 1);
  const frontmatter = raw.slice(0, fmEnd + 1);
  await fs.writeFile(abs, `${frontmatter}\n${newBody}\n`, "utf8");
}

describe("resolveConflictsAsSiblings via SyncEngine", () => {
  it("keeps both versions of a same-file conflict without markers and records it", async () => {
    const aliceEngine = new SyncEngine(fx.alice);
    const bobEngine = new SyncEngine(fx.bob);

    // Seed a shared note on the remote via alice.
    const seeded = await writeNote(fx.alice, {
      kind: "memory",
      title: "Shared editable fact",
      body: "original body",
    });
    await aliceEngine.syncOnce();

    // Bob pulls it so both clones have the SAME file.
    await bobEngine.syncOnce();
    const relPath = seeded.path;
    expect(await fs.readFile(path.join(fx.bob, relPath), "utf8")).toContain("original body");

    // Both edit the SAME file to different content and commit locally.
    await editNoteBody(fx.alice, relPath, "ALICE rewrote this");
    git(fx.alice, ["add", "-A"]);
    git(fx.alice, ["commit", "-qm", "alice edit"]);

    await editNoteBody(fx.bob, relPath, "BOB rewrote this");
    git(fx.bob, ["add", "-A"]);
    git(fx.bob, ["commit", "-qm", "bob edit"]);

    // Alice pushes first; bob's sync must rebase onto it and hit a same-file conflict.
    await aliceEngine.syncOnce();
    const summary = await bobEngine.syncOnce();

    // (a) It resolved without throwing, and reported the conflict.
    expect(summary.conflicts.length).toBeGreaterThan(0);

    // (a) Repo is clean and NOT mid-rebase.
    expect(git(fx.bob, ["status", "--porcelain"])).toBe("");
    await expect(fs.access(path.join(fx.bob, ".git", "rebase-merge"))).rejects.toBeTruthy();
    await expect(fs.access(path.join(fx.bob, ".git", "rebase-apply"))).rejects.toBeTruthy();

    // (c) NO conflict markers anywhere.
    const files = await listMarkdown(fx.bob);
    for (const f of files) {
      const content = await fs.readFile(path.join(fx.bob, f), "utf8");
      expect(content).not.toContain("<<<<<<<");
      expect(content).not.toContain("=======");
      expect(content).not.toContain(">>>>>>>");
    }

    // (b) BOTH contents survive as separate note files.
    const bodies = (await listNotes(fx.bob, "memory")).map((n) => n.body);
    const joined = bodies.join("\n---\n");
    expect(joined).toContain("ALICE rewrote this");
    expect(joined).toContain("BOB rewrote this");
    // Two distinct sibling files carry the two versions (they have distinct ids).
    const carriers = bodies.filter(
      (b) => b.includes("ALICE rewrote this") || b.includes("BOB rewrote this"),
    );
    expect(carriers.length).toBeGreaterThanOrEqual(2);

    // (d) A conflict record exists (memory note tagged "conflict").
    const conflictNotes = (await listNotes(fx.bob, "memory")).filter((n) =>
      n.frontmatter.tags.includes("conflict"),
    );
    expect(conflictNotes.length).toBeGreaterThan(0);

    // And bob successfully pushed the resolution back up.
    expect(summary.pushed).toBe(true);
  });
});
