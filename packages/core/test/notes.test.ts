import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ids from "../src/ids";
import { makeNoteId, slugify } from "../src/ids";
import { listNotes, parseNote, readNote, serializeNote, writeNote } from "../src/notes";
import type { Note } from "../src/schema";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-notes-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("ids", () => {
  it("slugifies and caps titles", () => {
    expect(slugify("Auth uses short-lived JWT!")).toBe("auth-uses-short-lived-jwt");
  });
  it("builds ids as <date>-<slug>-<shortid>", () => {
    const id = makeNoteId("Auth choice", "2026-07-01", "a1b2");
    expect(id).toBe("2026-07-01-auth-choice-a1b2");
  });
});

describe("parse/serialize round-trip", () => {
  it("round-trips a memory note", () => {
    const note: Note = {
      frontmatter: {
        id: "2026-07-01-x-a1b2",
        kind: "memory",
        title: "X",
        tags: ["auth"],
        created: "2026-07-01",
        relates: [],
        status: "active",
        sources: [],
      },
      body: "Body text.",
      path: "memory/2026-07-01-x-a1b2.md",
    };
    const raw = serializeNote(note);
    const back = parseNote(raw, note.path);
    expect(back.frontmatter).toEqual(note.frontmatter);
    expect(back.body).toBe("Body text.");
    // id and kind lead the frontmatter for readability
    expect(raw.indexOf("id:")).toBeLessThan(raw.indexOf("title:"));
  });
});

describe("writeNote / readNote / listNotes", () => {
  it("writes an atomic file at the derived path and reads it back", async () => {
    const note = await writeNote(dir, {
      kind: "decision",
      title: "JWT over sessions",
      body: "Because edge.",
      tags: ["auth"],
      author: "kristof",
      created: "2026-06-30",
      fields: { status: "accepted", deciders: ["kristof"] },
    });
    expect(note.path).toMatch(/^decisions\/2026-06-30-jwt-over-sessions-[0-9a-z]{4}\.md$/);
    const onDisk = await readNote(dir, note.path);
    expect(onDisk.frontmatter).toEqual(note.frontmatter);
    if (onDisk.frontmatter.kind === "decision") {
      expect(onDisk.frontmatter.status).toBe("accepted");
      expect(onDisk.frontmatter.deciders).toEqual(["kristof"]);
    }
  });

  it("defaults created to a YYYY-MM-DD date", async () => {
    const note = await writeNote(dir, { kind: "memory", title: "T", body: "b" });
    expect(note.frontmatter.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("lists notes and filters by kind", async () => {
    await writeNote(dir, { kind: "memory", title: "M1", body: "b" });
    await writeNote(dir, { kind: "person", title: "Dana", body: "b", fields: { name: "Dana" } });
    expect(await listNotes(dir)).toHaveLength(2);
    const people = await listNotes(dir, "person");
    expect(people).toHaveLength(1);
    expect(people[0]!.frontmatter.kind).toBe("person");
  });

  it("skips a single malformed note instead of failing the whole read (#80)", async () => {
    await writeNote(dir, { kind: "memory", title: "Good one", body: "a valid note" });
    await writeNote(dir, { kind: "memory", title: "Good two", body: "another valid note" });
    // A corrupt/hand-edited note with unparseable frontmatter lands in the kind folder.
    await fs.writeFile(
      path.join(dir, "memory", "broken.md"),
      "---\nnot: [valid\n---\noops\n",
      "utf8",
    );

    // listNotes must return the two good notes, not throw a brain-wide read outage.
    const notes = await listNotes(dir, "memory");
    expect(notes.map((n) => n.frontmatter.title).sort()).toEqual(["Good one", "Good two"]);
  });

  it("rejects invalid frontmatter", () => {
    expect(() => parseNote("---\nkind: nope\n---\nx", "x.md")).toThrow();
  });

  it("preserves unknown frontmatter keys across parse→serialize (#81)", () => {
    const raw = [
      "---",
      "id: 2026-07-01-x-a1b2",
      "kind: memory",
      "title: X",
      "created: 2026-07-01",
      "customField: keep-me", // not in the schema
      "forwardVersionKey: 42", // e.g. a field a newer schema added
      "---",
      "body",
    ].join("\n");
    const note = parseNote(raw, "memory/x.md");
    // The unknown keys survive parsing…
    expect((note.frontmatter as Record<string, unknown>).customField).toBe("keep-me");
    expect((note.frontmatter as Record<string, unknown>).forwardVersionKey).toBe(42);
    // …and round-trip through serialization (not silently dropped).
    const round = parseNote(serializeNote(note), "memory/x.md");
    expect((round.frontmatter as Record<string, unknown>).customField).toBe("keep-me");
    expect((round.frontmatter as Record<string, unknown>).forwardVersionKey).toBe(42);
  });
});

describe("path containment (#76, #77)", () => {
  it("readNote refuses a path that escapes the brain", async () => {
    await expect(readNote(dir, "../outside.md")).rejects.toThrow(/escapes the brain/);
    await expect(readNote(dir, "../../../../etc/passwd")).rejects.toThrow(/escapes the brain/);
  });

  it("caller `fields` cannot override the derived id", async () => {
    const note = await writeNote(dir, {
      kind: "memory",
      title: "Honest fact",
      body: "b",
      created: "2026-07-01",
      // A poisoned candidate trying to hijack the id and desync it from the filename.
      fields: { id: "../../evil", status: "active" },
    });
    // The derived id wins, and the file lives at the safe derived path.
    expect(note.frontmatter.id).toMatch(/^2026-07-01-honest-fact-[0-9a-z]{4}$/);
    expect(note.path).toBe(`memory/${note.frontmatter.id}.md`);
    const back = await readNote(dir, note.path);
    expect(back.frontmatter.id).toBe(note.frontmatter.id);
  });

  it("parseNote rejects a note whose id is not a single safe segment", () => {
    const raw = "---\nid: ../../evil\nkind: memory\ntitle: X\ncreated: 2026-07-01\n---\nbody";
    expect(() => parseNote(raw, "memory/x.md")).toThrow();
  });

  it("writeNote refuses to overwrite an existing note on an id collision (#101)", async () => {
    // Force both writes to derive the SAME id so the second targets an existing file.
    const spy = vi.spyOn(ids, "makeNoteId").mockReturnValue("2026-07-01-fixed-abcd");
    try {
      const first = await writeNote(dir, { kind: "memory", title: "One", body: "first body" });
      expect(first.path).toBe("memory/2026-07-01-fixed-abcd.md");
      // The colliding second write must throw, NOT silently overwrite the first.
      await expect(
        writeNote(dir, { kind: "memory", title: "Two", body: "second body" }),
      ).rejects.toThrow(/id collision/);
      // The original file is intact (not clobbered) and no temp file leaked.
      expect(await readNote(dir, first.path)).toMatchObject({ body: "first body" });
      const files = await fs.readdir(path.join(dir, "memory"));
      expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("project provenance (ADR-0015)", () => {
  it("writeNote files a sourced note under <project>/<kind>/ and records source frontmatter", async () => {
    const note = await writeNote(dir, {
      kind: "memory",
      title: "Cache TTL is five minutes",
      body: "The edge cache holds responses for five minutes.",
      source: "acme/widgets",
    });
    expect(note.path).toBe(`acme-widgets/memory/${note.frontmatter.id}.md`);
    expect(note.frontmatter.source).toBe("acme/widgets");
    // The file really exists at that path and round-trips.
    const back = await readNote(dir, note.path);
    expect(back.frontmatter.source).toBe("acme/widgets");
  });

  it("writeNote keeps an unattributed note at the kind root (back-compat)", async () => {
    const note = await writeNote(dir, { kind: "memory", title: "plain", body: "no project here" });
    expect(note.path).toBe(`memory/${note.frontmatter.id}.md`);
    expect(note.frontmatter.source).toBeUndefined();
  });

  it("listNotes finds notes across project subtrees and the flat root, filtered by kind", async () => {
    await writeNote(dir, { kind: "memory", title: "A", body: "from project one", source: "one" });
    await writeNote(dir, { kind: "memory", title: "B", body: "from project two", source: "two" });
    await writeNote(dir, {
      kind: "decision",
      title: "D",
      body: "a decision in project one",
      source: "one",
    });
    await writeNote(dir, { kind: "memory", title: "C", body: "an unattributed memory" });

    const memories = await listNotes(dir, "memory");
    expect(memories).toHaveLength(3); // A, B, C — across two projects + flat
    const all = await listNotes(dir);
    expect(all).toHaveLength(4);
    // Sourced notes carry their project; the flat one does not.
    const bySource = Object.fromEntries(
      all.map((n) => [n.frontmatter.title, n.frontmatter.source]),
    );
    expect(bySource).toEqual({ A: "one", B: "two", D: "one", C: undefined });
  });
});
