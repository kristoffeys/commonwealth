import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("rejects invalid frontmatter", () => {
    expect(() => parseNote("---\nkind: nope\n---\nx", "x.md")).toThrow();
  });
});
