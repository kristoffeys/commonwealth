import { describe, expect, it } from "vitest";
import { isGraduatable } from "../src/graduate-policy";
import type { Frontmatter, Note } from "../src/schema";

// Graduation-control policy (#168, ADR-0023): strictly opt-in eligibility for org-brain graduation.

function note(fm: Partial<Frontmatter> & Pick<Frontmatter, "kind">): Note {
  const base = {
    id: "2026-07-01-x-a1b2",
    title: "X",
    tags: [] as string[],
    created: "2026-07-01",
    relates: [] as string[],
  };
  const frontmatter = { ...base, ...fm } as Frontmatter;
  return { frontmatter, body: "b", path: `${fm.kind}/x.md` };
}

describe("isGraduatable", () => {
  it("is false without the explicit opt-in (the default)", () => {
    expect(isGraduatable(note({ kind: "memory", status: "active", sources: [] }))).toBe(false);
    expect(
      isGraduatable(note({ kind: "memory", status: "active", sources: [], graduate: false })),
    ).toBe(false);
  });

  it("is true for an active, opted-in memory note", () => {
    expect(
      isGraduatable(note({ kind: "memory", status: "active", sources: [], graduate: true })),
    ).toBe(true);
  });

  it("is false for an opted-in memory note that is not active", () => {
    for (const status of ["superseded", "stale"] as const) {
      expect(isGraduatable(note({ kind: "memory", status, sources: [], graduate: true }))).toBe(
        false,
      );
    }
  });

  it("graduates a decision only when decisions are allowed AND it is accepted", () => {
    const accepted = note({
      kind: "decision",
      status: "accepted",
      graduate: true,
      supersedes: [],
      deciders: [],
    });
    expect(isGraduatable(accepted)).toBe(false); // decisions off by default
    expect(isGraduatable(accepted, { allowDecisions: true })).toBe(true);

    const proposed = note({
      kind: "decision",
      status: "proposed",
      graduate: true,
      supersedes: [],
      deciders: [],
    });
    expect(isGraduatable(proposed, { allowDecisions: true })).toBe(false);
  });

  it("never graduates work-state or person notes, even opted-in", () => {
    expect(isGraduatable(note({ kind: "work-state", status: "done", graduate: true }))).toBe(false);
    expect(isGraduatable(note({ kind: "person", name: "Ada", graduate: true }))).toBe(false);
  });
});
