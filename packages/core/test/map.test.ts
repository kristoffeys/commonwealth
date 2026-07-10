import { describe, expect, it } from "vitest";
import { brainMap, UNATTRIBUTED } from "../src/map";
import type { Note, NoteKind } from "../src/schema";

/** Build a minimal Note of the given kind for the map rollup (only kind + author matter here). */
function note(id: string, kind: NoteKind, author?: string): Note {
  const base = {
    id,
    kind,
    title: id,
    tags: [] as string[],
    created: "2026-07-01",
    relates: [] as string[],
    ...(author ? { author } : {}),
  };
  // Kind-specific required fields; the rollup ignores them but the type demands them.
  const fm =
    kind === "memory"
      ? { ...base, status: "active", sources: [] }
      : kind === "decision"
        ? { ...base, status: "proposed", supersedes: [], deciders: [] }
        : kind === "work-state"
          ? { ...base, status: "planned" }
          : { ...base, name: id };
  return { frontmatter: fm as Note["frontmatter"], body: "b", path: `${kind}/${id}.md` };
}

describe("brainMap (#205)", () => {
  it("reports an empty brain as total 0 with every kind present at 0 and no contributors", () => {
    const m = brainMap([]);
    expect(m.total).toBe(0);
    expect(m.byKind).toEqual([
      { kind: "memory", count: 0 },
      { kind: "decision", count: 0 },
      { kind: "work-state", count: 0 },
      { kind: "person", count: 0 },
    ]);
    expect(m.contributors).toEqual([]);
  });

  it("counts per kind in canonical order, keeping absent kinds visible at 0", () => {
    const m = brainMap([
      note("a", "memory"),
      note("b", "memory"),
      note("c", "decision"),
      note("d", "person"),
    ]);
    expect(m.total).toBe(4);
    expect(m.byKind).toEqual([
      { kind: "memory", count: 2 },
      { kind: "decision", count: 1 },
      { kind: "work-state", count: 0 }, // absent kind still listed
      { kind: "person", count: 1 },
    ]);
  });

  it("ranks contributors by note count, then author name for ties", () => {
    const m = brainMap([
      note("a", "memory", "bob"),
      note("b", "memory", "alice"),
      note("c", "decision", "alice"),
      note("d", "memory", "carol"),
    ]);
    // alice 2, then bob & carol tie at 1 → alphabetical.
    expect(m.contributors).toEqual([
      { author: "alice", count: 2 },
      { author: "bob", count: 1 },
      { author: "carol", count: 1 },
    ]);
  });

  it("groups notes with no (or blank) author under UNATTRIBUTED", () => {
    const m = brainMap([
      note("a", "memory"),
      note("b", "decision", "   "),
      note("c", "memory", "alice"),
    ]);
    expect(m.contributors).toEqual([
      { author: UNATTRIBUTED, count: 2 },
      { author: "alice", count: 1 },
    ]);
  });

  it("trims author whitespace so ' alice ' and 'alice' are one contributor", () => {
    const m = brainMap([note("a", "memory", " alice "), note("b", "memory", "alice")]);
    expect(m.contributors).toEqual([{ author: "alice", count: 2 }]);
  });
});
