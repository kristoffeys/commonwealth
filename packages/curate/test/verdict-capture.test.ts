import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initBrain, listNotes, readNote, setFeature, writeNote } from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureCandidates } from "../src/capture.js";
import { listPending } from "../src/review.js";
import { parseVerdict, planCandidate, CONTRADICTED_TAG } from "../src/verdict.js";
import type { AnnotatedCandidate } from "../src/verdict.js";

/**
 * The LLM curation pass (ADR-0030): curate APPLIES the durability/consolidation verdict the hook
 * layer attached to each candidate, deterministically. The fail-safe posture is the crux —
 * absent/malformed verdicts must behave EXACTLY like today (DISTINCT), and only a valid LLM verdict
 * may drop (duplicate) or merge (supersedes) a fact; a contradiction is NEVER auto-rejected (#214).
 */

let brainDir: string;

/** Seed a canon note with a trusted id so verdicts can target it. */
async function seedCanon(id: string, title: string, body: string, kind: "memory" | "decision") {
  await writeNote(brainDir, { id, kind, title, body });
}

beforeEach(async () => {
  brainDir = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-curate-verdict-"));
  await initBrain(brainDir, { name: "verdict-brain" });
});

afterEach(async () => {
  await fs.rm(brainDir, { recursive: true, force: true });
});

describe("parseVerdict (fail-safe DISTINCT)", () => {
  it("defaults every unreadable / partial verdict to distinct + durable", () => {
    expect(parseVerdict(undefined)).toBeUndefined();
    expect(parseVerdict("garbage")).toBeUndefined();
    expect(parseVerdict({})).toEqual({ judge: "durable", consolidation: "distinct" });
    // A consolidation relation with no target can't be acted on → degrade to distinct.
    expect(parseVerdict({ consolidation: "supersedes" })).toEqual({
      judge: "durable",
      consolidation: "distinct",
    });
    expect(parseVerdict({ judge: "bogus", consolidation: "bogus" })).toEqual({
      judge: "durable",
      consolidation: "distinct",
    });
  });

  it("keeps a well-formed verdict", () => {
    expect(
      parseVerdict({ judge: "trivia", consolidation: "duplicate", targetId: "x", reason: "r" }),
    ).toEqual({ judge: "trivia", consolidation: "duplicate", targetId: "x", reason: "r" });
  });
});

describe("planCandidate", () => {
  it("filters trivia, rejects duplicates, and stamps supersedes/contradicts frontmatter", () => {
    const base = {
      kind: "memory",
      title: "T",
      body: "a body long enough to pass the gate",
    } as const;

    expect(planCandidate({ ...base, verdict: { judge: "trivia" } })).toMatchObject({
      action: "reject",
      reason: "llm-trivia",
    });
    expect(
      planCandidate({ ...base, verdict: { consolidation: "duplicate", targetId: "old-1" } }),
    ).toMatchObject({ action: "reject", reason: "llm-duplicate", duplicateOf: "old-1" });

    const sup = planCandidate({
      ...base,
      verdict: { consolidation: "supersedes", targetId: "old-1" },
    });
    expect(sup.action).toBe("stage");
    if (sup.action === "stage") {
      expect(sup.supersedes).toBe("old-1");
      expect(sup.input.id).toBeTruthy();
      expect((sup.input.fields as Record<string, unknown>).supersedes).toEqual(["old-1"]);
    }

    const con = planCandidate({
      ...base,
      verdict: { consolidation: "contradicts", targetId: "old-1" },
    });
    expect(con.action).toBe("stage");
    if (con.action === "stage") {
      expect(con.contradicts).toBe("old-1");
      expect((con.input.fields as Record<string, unknown>).contradicts).toEqual(["old-1"]);
      expect(con.input.tags).toContain(CONTRADICTED_TAG);
    }
  });

  it("treats absent/malformed verdicts as distinct (no id assigned, no fields injected)", () => {
    const base = {
      kind: "memory",
      title: "T",
      body: "a body long enough to pass the gate",
    } as const;
    const plan = planCandidate({ ...base });
    expect(plan).toEqual({ action: "stage", input: base });
  });

  it("clamps a consolidation whose targetId is NOT in the candidate's neighbor set → distinct", () => {
    const base = {
      kind: "memory",
      title: "T",
      body: "a body long enough to pass the gate",
    } as const;
    // neighborIds present (the pipeline case) but the verdict cites a note never surfaced for it.
    for (const consolidation of ["duplicate", "supersedes", "contradicts"] as const) {
      const plan = planCandidate({
        ...base,
        neighborIds: ["real-neighbor-1"],
        verdict: { consolidation, targetId: "arbitrary-id" },
      });
      expect(plan).toMatchObject({ action: "stage", clamped: "target-not-in-neighbor-set" });
    }
  });

  it("acts on a consolidation whose targetId IS a declared neighbor", () => {
    const base = {
      kind: "memory",
      title: "T",
      body: "a body long enough to pass the gate",
    } as const;
    const plan = planCandidate(
      {
        ...base,
        neighborIds: ["real-neighbor-1"],
        verdict: { consolidation: "duplicate", targetId: "real-neighbor-1" },
      },
      { existingIds: new Set(["real-neighbor-1"]) },
    );
    expect(plan).toMatchObject({
      action: "reject",
      reason: "llm-duplicate",
      duplicateOf: "real-neighbor-1",
    });
  });

  it("clamps a duplicate whose target does not exist in canon, even with no neighbor set", () => {
    const base = {
      kind: "memory",
      title: "T",
      body: "a body long enough to pass the gate",
    } as const;
    const plan = planCandidate(
      { ...base, verdict: { consolidation: "duplicate", targetId: "totally-made-up-id" } },
      { existingIds: new Set(["some-real-id"]) },
    );
    expect(plan).toMatchObject({ action: "stage", clamped: "duplicate-target-not-in-canon" });
  });
});

describe("captureCandidates applies verdicts", () => {
  const body = (s: string) => `${s} — a body comfortably past the fifteen character floor.`;

  it("filters a trivia candidate: logged reason, never staged", async () => {
    const cands: AnnotatedCandidate[] = [
      { kind: "memory", title: "Ran the tests", body: body("green"), verdict: { judge: "trivia" } },
    ];
    const result = await captureCandidates(brainDir, cands);
    expect(result.staged).toHaveLength(0);
    expect(result.triviaFiltered).toBe(1);
    expect(result.rejected).toEqual([expect.objectContaining({ reason: "llm-trivia" })]);
    expect(await listNotes(brainDir)).toHaveLength(0);
  });

  it("rejects a duplicate candidate with duplicateOf = targetId", async () => {
    await seedCanon("2026-07-01-jwt-a1", "JWT auth", body("we use JWT"), "memory");
    const cands: AnnotatedCandidate[] = [
      {
        kind: "memory",
        title: "JWT auth restated",
        body: body("we use JWT tokens"),
        verdict: { consolidation: "duplicate", targetId: "2026-07-01-jwt-a1" },
      },
    ];
    const result = await captureCandidates(brainDir, cands);
    expect(result.staged).toHaveLength(0);
    expect(result.rejected).toEqual([
      expect.objectContaining({ reason: "llm-duplicate", duplicateOf: "2026-07-01-jwt-a1" }),
    ]);
  });

  it("supersedes: promotes the new note AND marks the target superseded (autoPromote on)", async () => {
    await seedCanon("2026-07-01-jwt-a1", "Auth uses JWT", body("15m JWT access tokens"), "memory");
    const cands: AnnotatedCandidate[] = [
      {
        kind: "memory",
        title: "Auth moved to opaque sessions",
        body: body("we replaced JWT with opaque server-side session tokens"),
        verdict: { consolidation: "supersedes", targetId: "2026-07-01-jwt-a1" },
      },
    ];
    const result = await captureCandidates(brainDir, cands);
    expect(result.superseded).toEqual([{ id: expect.any(String), targetId: "2026-07-01-jwt-a1" }]);
    const newId = result.superseded[0]!.id;

    // Target canon note is now superseded_by the new note.
    const canon = await listNotes(brainDir);
    const target = canon.find((n) => n.frontmatter.id === "2026-07-01-jwt-a1")!;
    expect(target.frontmatter.kind === "memory" && target.frontmatter.status).toBe("superseded");
    expect(target.frontmatter.kind === "memory" && target.frontmatter.superseded_by).toBe(newId);

    // New note reached canon and carries the forward `supersedes` link.
    const fresh = canon.find((n) => n.frontmatter.id === newId)!;
    expect((fresh.frontmatter as Record<string, unknown>).supersedes).toEqual([
      "2026-07-01-jwt-a1",
    ]);
  });

  it("supersedes: leaves the target untouched when autoPromote is off (surfaced for review)", async () => {
    await setFeature(brainDir, "autoPromote", false);
    await seedCanon("2026-07-01-jwt-a1", "Auth uses JWT", body("15m JWT access tokens"), "memory");
    const cands: AnnotatedCandidate[] = [
      {
        kind: "memory",
        title: "Auth moved to opaque sessions",
        body: body("we replaced JWT with opaque server-side session tokens"),
        verdict: { consolidation: "supersedes", targetId: "2026-07-01-jwt-a1" },
      },
    ];
    const result = await captureCandidates(brainDir, cands);
    // No supersession applied (new note isn't canon yet) — but the intent rides the staged note.
    expect(result.superseded).toHaveLength(0);
    const target = await readNote(brainDir, "memory/2026-07-01-jwt-a1.md");
    expect(target.frontmatter.kind === "memory" && target.frontmatter.status).toBe("active");
    const pending = await listPending(brainDir);
    expect((pending[0]!.frontmatter as Record<string, unknown>).supersedes).toEqual([
      "2026-07-01-jwt-a1",
    ]);
  });

  it("contradicts: stages/promotes with the marker + tag, never auto-rejected (#214)", async () => {
    await seedCanon("2026-07-01-jwt-a1", "Auth uses JWT", body("we use JWT everywhere"), "memory");
    const cands: AnnotatedCandidate[] = [
      {
        kind: "memory",
        title: "Auth does not use JWT",
        body: body("the gateway rejects JWT and only accepts opaque tokens"),
        verdict: { consolidation: "contradicts", targetId: "2026-07-01-jwt-a1" },
      },
    ];
    const result = await captureCandidates(brainDir, cands);
    expect(result.staged).toHaveLength(1);
    expect(result.contradictions).toEqual([
      { id: expect.any(String), targetId: "2026-07-01-jwt-a1" },
    ]);
    const fresh = (await listNotes(brainDir)).find(
      (n) => n.frontmatter.id === result.contradictions[0]!.id,
    )!;
    expect((fresh.frontmatter as Record<string, unknown>).contradicts).toEqual([
      "2026-07-01-jwt-a1",
    ]);
    expect(fresh.frontmatter.tags).toContain(CONTRADICTED_TAG);
  });

  it("absent verdict behaves exactly like today (DISTINCT — staged/promoted, no consolidation)", async () => {
    const cands: AnnotatedCandidate[] = [
      { kind: "memory", title: "Plain fact", body: body("a durable fact with no verdict") },
    ];
    const result = await captureCandidates(brainDir, cands);
    expect(result.staged).toHaveLength(1);
    expect(result.promoted).toHaveLength(1);
    expect(result.superseded).toHaveLength(0);
    expect(result.contradictions).toHaveLength(0);
    expect(result.triviaFiltered).toBe(0);
  });

  it("does not supersede when the new note is dropped by the deterministic gate", async () => {
    await seedCanon("2026-07-01-jwt-a1", "Auth uses JWT", body("15m JWT access tokens"), "memory");
    // Too-thin body → the gate rejects it, so the supersession must NOT fire.
    const cands: AnnotatedCandidate[] = [
      {
        kind: "memory",
        title: "x",
        body: "short",
        verdict: { consolidation: "supersedes", targetId: "2026-07-01-jwt-a1" },
      },
    ];
    const result = await captureCandidates(brainDir, cands);
    expect(result.staged).toHaveLength(0);
    expect(result.superseded).toHaveLength(0);
    const target = await readNote(brainDir, "memory/2026-07-01-jwt-a1.md");
    expect(target.frontmatter.kind === "memory" && target.frontmatter.status).toBe("active");
  });

  it("verifier probe: a duplicate verdict with a made-up targetId → candidate SURVIVES (not dropped)", async () => {
    const cands: AnnotatedCandidate[] = [
      {
        kind: "memory",
        title: "A genuinely durable fact",
        body: body("the deploy pipeline requires a named release owner for every production push"),
        verdict: { consolidation: "duplicate", targetId: "totally-made-up-id" },
      },
    ];
    const result = await captureCandidates(brainDir, cands);
    // The fabricated target does not exist in canon → clamp to DISTINCT → the fact is KEPT.
    expect(result.staged).toHaveLength(1);
    expect(result.clamped).toBe(1);
    expect(result.rejected).toHaveLength(0);
    expect(await listNotes(brainDir)).toHaveLength(1);
  });

  it("injection: a duplicate targetId that is real canon but NOT this candidate's neighbor → survives", async () => {
    // A real, unrelated canon note (would be a valid duplicate target for SOME other candidate).
    await seedCanon(
      "2026-07-01-cache-b2",
      "Edge cache TTL",
      body("five minute edge TTL"),
      "memory",
    );
    const cands: AnnotatedCandidate[] = [
      {
        kind: "memory",
        title: "Unrelated durable fact about auth",
        body: body("auth tokens now rotate every twenty-four hours via the gateway"),
        // The candidate's OWN neighbor set does not include the cited target — injection attempt.
        neighborIds: ["2026-07-01-something-else"],
        verdict: { consolidation: "duplicate", targetId: "2026-07-01-cache-b2" },
      },
    ];
    const result = await captureCandidates(brainDir, cands);
    expect(result.staged).toHaveLength(1);
    expect(result.clamped).toBe(1);
    expect(result.rejected).toHaveLength(0);
  });

  it("batched injection: an injected sibling verdict cannot drop a legitimate sibling", async () => {
    await seedCanon("2026-07-01-jwt-a1", "Auth uses JWT", body("we use JWT tokens"), "memory");
    const cands: AnnotatedCandidate[] = [
      // Sibling A: legitimately a duplicate of its neighbor → correctly dropped.
      {
        kind: "memory",
        title: "JWT auth restated",
        body: body("the service authenticates with JWT tokens"),
        neighborIds: ["2026-07-01-jwt-a1"],
        verdict: { consolidation: "duplicate", targetId: "2026-07-01-jwt-a1" },
      },
      // Sibling B: a real, independent fact the injected batch tries to drop by citing A's target,
      // which is NOT in B's neighbor set → clamp → B survives.
      {
        kind: "memory",
        title: "Deploys need a release owner",
        body: body("every production deploy must name one explicit release owner"),
        neighborIds: [],
        verdict: { consolidation: "duplicate", targetId: "2026-07-01-jwt-a1" },
      },
    ];
    const result = await captureCandidates(brainDir, cands);
    // A dropped (valid), B kept (clamped) — the injection could not take out the sibling.
    expect(result.clamped).toBe(1);
    const titles = (await listNotes(brainDir)).map((n) => n.frontmatter.title);
    expect(titles).toContain("Deploys need a release owner");
    expect(titles).not.toContain("JWT auth restated");
  });
});
