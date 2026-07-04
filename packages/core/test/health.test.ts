import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brainHealth, computeBrainHealth } from "../src/health";
import { writeNote } from "../src/notes";
import type { Note } from "../src/schema";

const NOW = "2026-07-04";

/** Build a memory Note with sensible defaults for the health rollup. */
function mem(id: string, over: Partial<Note["frontmatter"]> = {}): Note {
  return {
    frontmatter: {
      id,
      kind: "memory",
      title: id,
      tags: [],
      created: "2026-07-01",
      relates: [],
      status: "active",
      sources: [],
      ...over,
    } as Note["frontmatter"],
    body: "b",
    path: `memory/${id}.md`,
  };
}

describe("brainHealth (#109)", () => {
  it("scores an empty brain 100 with all-zero buckets", () => {
    const h = brainHealth([], { now: NOW });
    expect(h).toMatchObject({
      total: 0,
      score: 100,
      stale: { count: 0 },
      unverified: { count: 0 },
      contradicted: { count: 0 },
      orphaned: { count: 0 },
    });
  });

  it("counts explicit stale status and age-based staleness", () => {
    const notes = [
      mem("a", { status: "stale", verified: NOW }), // explicit stale
      mem("b", { verified: "2026-01-01" }), // verified >90d ago → stale
      mem("c", { verified: NOW }), // fresh → not stale
    ];
    const h = brainHealth(notes, { now: NOW, staleAfterDays: 90 });
    expect(h.stale.ids).toEqual(["a", "b"]);
    expect(h.stale.count).toBe(2);
  });

  it("flags active memory notes with no verified date as unverified", () => {
    const h = brainHealth([mem("a"), mem("b", { verified: NOW })], { now: NOW });
    expect(h.unverified.ids).toEqual(["a"]);
  });

  it("flags a note carrying a `contradicted` tag (case-insensitive)", () => {
    const h = brainHealth([mem("a", { tags: ["Contradicted"] }), mem("b")], { now: NOW });
    expect(h.contradicted.ids).toEqual(["a"]);
  });

  it("treats a note with no inbound links as orphaned; a linked note is not", () => {
    const notes = [mem("a", { relates: ["b"] }), mem("b", { verified: NOW })];
    const h = brainHealth(notes, { now: NOW });
    // `b` is referenced by `a` → not orphaned; `a` is referenced by nobody → orphaned.
    expect(h.orphaned.ids).toEqual(["a"]);
  });

  it("resolves [[wikilink]] references when computing backlinks", () => {
    const notes = [mem("a", { relates: ["[[b]]"] }), mem("b", { verified: NOW })];
    expect(brainHealth(notes, { now: NOW }).orphaned.ids).not.toContain("b");
  });

  it("penalizes serious (stale/contradicted) fully and soft (unverified/orphaned) at half", () => {
    // 4 notes: one stale, one clean+linked, two only-soft (unverified+orphaned).
    const notes = [
      mem("a", { status: "stale", relates: ["b"] }), // serious (stale), links b
      mem("b", { verified: NOW, relates: ["a"] }), // clean, linked
      mem("c"), // soft: unverified + orphaned
      mem("d"), // soft: unverified + orphaned
    ];
    const h = brainHealth(notes, { now: NOW });
    // serious = {a}=1; soft = {c,d}=2 (b is clean/linked). score = 100*(1-(1+0.5*2)/4)=50.
    expect(h.score).toBe(50);
  });
});

describe("computeBrainHealth (from disk)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-health-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reads the note set and reports totals", async () => {
    await writeNote(dir, { kind: "memory", title: "Fresh fact", body: "verified today" });
    await writeNote(dir, { kind: "work-state", title: "WIP", body: "in progress" });
    const h = await computeBrainHealth(dir);
    expect(h.total).toBe(2);
    expect(h.score).toBeGreaterThanOrEqual(0);
    expect(h.score).toBeLessThanOrEqual(100);
  });
});
