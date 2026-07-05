import { promises as fs } from "node:fs";
import path from "node:path";
import { listNotes, writeNote } from "@cmnwlth/core";
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

/** Absolute path to the single memory note under a working copy. */
async function memoryNotePath(dir: string): Promise<string> {
  const [note] = await listNotes(dir, "memory");
  if (!note) throw new Error("expected a memory note");
  return path.join(dir, note.path);
}

describe("SyncEngine secret scrub (#16)", () => {
  it("does not commit or push a note containing a secret", async () => {
    const engine = new SyncEngine(fx.alice);

    // Write a legitimate note, then overwrite its file with a secret (hand-edit vector).
    await writeNote(fx.alice, { kind: "memory", title: "Creds note", body: "placeholder body" });
    const notePath = await memoryNotePath(fx.alice);
    const rel = path.relative(fx.alice, notePath);
    await fs.writeFile(
      notePath,
      `${await fs.readFile(notePath, "utf8")}\n\naws key AKIAIOSFODNN7EXAMPLE here\n`,
    );

    const summary = await engine.syncOnce();

    // The offending note is reported and withheld.
    expect(summary.secretsBlocked).toContain(rel);

    // It is NOT in git history.
    const log = git(fx.alice, ["log", "--all", "--name-only", "--pretty=format:"]);
    expect(log).not.toContain(rel);

    // It is still modified/uncommitted in the working tree.
    const status = git(fx.alice, ["status", "--porcelain", "--", rel]);
    expect(status.length).toBeGreaterThan(0);

    // The secret never reached the remote: bob pulling gets no such note body.
    const bobEngine = new SyncEngine(fx.bob);
    await bobEngine.syncOnce();
    const bobNotes = await listNotes(fx.bob, "memory");
    expect(bobNotes.some((n) => n.body.includes("AKIAIOSFODNN7EXAMPLE"))).toBe(false);
  });

  it("commits clean notes normally with an empty secretsBlocked", async () => {
    const engine = new SyncEngine(fx.alice);
    await writeNote(fx.alice, { kind: "memory", title: "Clean note", body: "nothing to hide" });

    const summary = await engine.syncOnce();

    expect(summary.secretsBlocked).toEqual([]);
    expect(summary.committed).toBe(true);
    expect(summary.pushed).toBe(true);

    const rel = path.relative(fx.alice, await memoryNotePath(fx.alice));
    const log = git(fx.alice, ["log", "--all", "--name-only", "--pretty=format:"]);
    expect(log).toContain(rel);
  });

  it("commits the clean part of a mixed batch, withholding only the secret note", async () => {
    const engine = new SyncEngine(fx.alice);
    await writeNote(fx.alice, { kind: "memory", title: "Clean one", body: "safe content here" });
    await writeNote(fx.alice, { kind: "memory", title: "Dirty one", body: "temp" });

    // Taint exactly one of the two note files.
    const notes = await listNotes(fx.alice, "memory");
    const dirty = notes.find((n) => n.frontmatter.title === "Dirty one")!;
    const dirtyPath = path.join(fx.alice, dirty.path);
    await fs.writeFile(
      dirtyPath,
      `${await fs.readFile(dirtyPath, "utf8")}\npassword = hunter2long\n`,
    );

    const summary = await engine.syncOnce();

    const dirtyRel = path.relative(fx.alice, dirtyPath);
    expect(summary.secretsBlocked).toEqual([dirtyRel]);
    expect(summary.committed).toBe(true);

    const log = git(fx.alice, ["log", "--all", "--name-only", "--pretty=format:"]);
    const cleanRel = path.relative(
      fx.alice,
      path.join(fx.alice, notes.find((n) => n.frontmatter.title === "Clean one")!.path),
    );
    expect(log).toContain(cleanRel);
    expect(log).not.toContain(dirtyRel);
  });
});

describe("SyncEngine secret scrub — derived files (#79)", () => {
  it("does not push a secret embedded in a note TITLE via the derived COMMONWEALTH.md", async () => {
    const engine = new SyncEngine(fx.alice);
    const SECRET = "AKIAIOSFODNN7EXAMPLE";
    // A work-state note whose TITLE carries a secret (a hand-edit / not through the capture
    // gate). Active work-state titles are rendered into the COMMONWEALTH.md router — which used
    // to escape the scrub because it isn't a note file.
    await writeNote(fx.alice, {
      kind: "work-state",
      title: `deploy key ${SECRET}`,
      body: "a placeholder body long enough to be a real note",
      fields: { status: "planned" },
    });

    const summary = await engine.syncOnce();

    // The generated router is now scanned, so it is withheld too.
    expect(summary.secretsBlocked).toContain("COMMONWEALTH.md");
    // The secret appears in NO commit — not the note, not the derived files.
    expect(git(fx.alice, ["log", "--all", "-p"])).not.toContain(SECRET);

    // And it never reached the remote: bob pulls and origin/main has no trace.
    await new SyncEngine(fx.bob).syncOnce();
    expect(git(fx.bob, ["log", "origin/main", "-p"])).not.toContain(SECRET);
  });
});

describe("SyncEngine secret scrub — project subtree layout (ADR-0015)", () => {
  it("scrubs a secret in a note under <project>/<kind>/ (scrub is layout-agnostic, #90)", async () => {
    const engine = new SyncEngine(fx.alice);
    // A sourced note lands at acme-widgets/memory/<id>.md, not the flat memory/ root.
    const note = await writeNote(fx.alice, {
      kind: "memory",
      title: "Sourced creds note",
      body: "placeholder",
      source: "acme/widgets",
    });
    expect(note.path.startsWith("acme-widgets/memory/")).toBe(true);
    const abs = path.join(fx.alice, note.path);
    await fs.writeFile(
      abs,
      `${await fs.readFile(abs, "utf8")}\n\naws key AKIAIOSFODNN7EXAMPLE here\n`,
    );

    const summary = await engine.syncOnce();

    // The scrub still catches it despite the deeper path.
    expect(summary.secretsBlocked).toContain(note.path);
    const log = git(fx.alice, ["log", "--all", "--name-only", "--pretty=format:"]);
    expect(log).not.toContain(note.path);
  });
});
