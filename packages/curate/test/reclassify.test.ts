import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initBrain, listNotes, setFeature, writeNote } from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyReclassify,
  planReclassify,
  reclassify,
  type ReclassifyInput,
  type ReclassifyJudge,
  type ReclassifyJudgment,
} from "../src/reclassify.js";

/**
 * Reclassification (#265): re-judge existing MEMORY notes and, for the ones that are really team
 * decisions, mint a `decision` note that SUPERSEDES the source. The LLM judge is injected (ADR-0030:
 * curate stays offline) — here it is a deterministic mock, so these tests exercise the whole engine
 * without a host model.
 */

let brainDir: string;

/** A judge that flags the given ids as decisions (optionally with a framed title/body). */
function judgeFlagging(
  decisions: Record<string, Partial<ReclassifyJudgment> | true>,
): ReclassifyJudge {
  return async (notes: ReclassifyInput[]) => {
    const out = new Map<string, ReclassifyJudgment>();
    for (const n of notes) {
      const hit = decisions[n.id];
      if (!hit) continue;
      const extra = hit === true ? {} : hit;
      out.set(n.id, { isDecision: true, title: "", body: "", reason: "", ...extra });
    }
    return out;
  };
}

beforeEach(async () => {
  brainDir = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-curate-reclassify-"));
  await initBrain(brainDir, { name: "reclassify-brain" });
});

afterEach(async () => {
  await fs.rm(brainDir, { recursive: true, force: true });
});

describe("planReclassify", () => {
  it("only considers ACTIVE memory notes, and returns those the judge flags", async () => {
    const decision = await writeNote(brainDir, {
      kind: "memory",
      title: "adopt Pinia Colada for data loading",
      body: "Standardize data-loading on Pinia Colada across the frontend.",
    });
    await writeNote(brainDir, {
      kind: "memory",
      title: "JWT numeric claims decode to int",
      body: "String type guards silently drop them.",
    });
    // A note the judge would flag, but it is already superseded → must be skipped (idempotency).
    const stale = await writeNote(brainDir, {
      kind: "memory",
      title: "adopt something old",
      body: "…",
    });
    // Mark it superseded on disk.
    const { supersedeNote } = await import("@cmnwlth/core");
    await supersedeNote(brainDir, stale.path, "some-survivor-id");

    const judge = judgeFlagging({
      [decision.frontmatter.id]: {
        title: "Standardize on Pinia Colada",
        body: "…because caching.",
      },
      [stale.frontmatter.id]: true,
    });
    const plan = await planReclassify(brainDir, judge);

    expect(plan.scanned).toBe(2); // the superseded note is not scanned
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]!.sourceId).toBe(decision.frontmatter.id);
    expect(plan.candidates[0]!.decisionTitle).toBe("Standardize on Pinia Colada");
    expect(plan.candidates[0]!.decisionBody).toBe("…because caching.");
  });

  it("falls back to the source note's title/body when the judge omits them", async () => {
    const n = await writeNote(brainDir, {
      kind: "memory",
      title: "standardize admin date format",
      body: "Use YYYY-MM-DD everywhere.",
    });
    const plan = await planReclassify(brainDir, judgeFlagging({ [n.frontmatter.id]: true }));
    expect(plan.candidates[0]!.decisionTitle).toBe("standardize admin date format");
    expect(plan.candidates[0]!.decisionBody).toBe("Use YYYY-MM-DD everywhere.");
  });

  it("scopes to one project by source and honors limit", async () => {
    await writeNote(brainDir, {
      kind: "memory",
      title: "A choice",
      body: "…",
      source: "org/repo-a",
    });
    const b = await writeNote(brainDir, {
      kind: "memory",
      title: "B choice",
      body: "…",
      source: "org/repo-b",
    });
    const flagAll: ReclassifyJudge = async (notes) =>
      new Map(notes.map((n) => [n.id, { isDecision: true, title: "", body: "", reason: "" }]));

    const scoped = await planReclassify(brainDir, flagAll, { project: "org/repo-b" });
    expect(scoped.scanned).toBe(1);
    expect(scoped.candidates[0]!.sourceId).toBe(b.frontmatter.id);

    const limited = await planReclassify(brainDir, flagAll, { limit: 1 });
    expect(limited.scanned).toBe(1);
  });

  it("does not call the judge when there are no memory notes", async () => {
    const judge = vi.fn(async () => new Map());
    const plan = await planReclassify(brainDir, judge as unknown as ReclassifyJudge);
    expect(plan).toEqual({ scanned: 0, candidates: [] });
    expect(judge).not.toHaveBeenCalled();
  });
});

describe("applyReclassify", () => {
  it("mints a decision that supersedes the source memory (autoPromote on)", async () => {
    const src = await writeNote(brainDir, {
      kind: "memory",
      title: "adopt Reka UI for dialogs",
      body: "Migrate modals to Reka UI Dialog for accessibility.",
      source: "org/frontend",
    });
    const plan = await planReclassify(
      brainDir,
      judgeFlagging({ [src.frontmatter.id]: { title: "Standardize dialogs on Reka UI" } }),
    );
    const result = await applyReclassify(brainDir, plan);

    expect(result.promoted).toHaveLength(1);
    expect(result.superseded).toEqual([{ id: expect.any(String), targetId: src.frontmatter.id }]);

    const decisions = await listNotes(brainDir, "decision");
    expect(decisions).toHaveLength(1);
    const d = decisions[0]!;
    expect(d.frontmatter.title).toBe("Standardize dialogs on Reka UI");
    expect(d.frontmatter.source).toBe("org/frontend");
    expect((d.frontmatter as { supersedes?: string[] }).supersedes).toEqual([src.frontmatter.id]);
    expect(d.frontmatter.tags).toContain("reclassified");
    // Decision lives under the per-project subtree (ADR-0015).
    expect(d.path).toMatch(/org-frontend\/decisions\/.+\.md$/);

    // The source memory note is superseded, not deleted.
    const memory = await listNotes(brainDir, "memory");
    const superseded = memory.find((n) => n.frontmatter.id === src.frontmatter.id)!;
    expect(superseded.frontmatter.status).toBe("superseded");
    expect((superseded.frontmatter as { superseded_by?: string }).superseded_by).toBe(
      d.frontmatter.id,
    );
  });

  it("respects the autoAdr gate: no decisions land, source untouched, when autoAdr is off", async () => {
    await setFeature(brainDir, "autoAdr", false);
    const src = await writeNote(brainDir, {
      kind: "memory",
      title: "adopt X",
      body: "We adopt X over Y.",
    });
    const plan = await planReclassify(brainDir, judgeFlagging({ [src.frontmatter.id]: true }));
    const result = await applyReclassify(brainDir, plan);

    expect(result.promoted).toHaveLength(0);
    expect(result.rejected.some((r) => r.reason === "auto-adr-disabled")).toBe(true);
    expect(await listNotes(brainDir, "decision")).toHaveLength(0);
    const src2 = (await listNotes(brainDir, "memory")).find(
      (n) => n.frontmatter.id === src.frontmatter.id,
    )!;
    expect(src2.frontmatter.status).toBe("active");
  });

  it("is idempotent: a superseded source is not re-proposed on a second pass", async () => {
    const src = await writeNote(brainDir, {
      kind: "memory",
      title: "refactor: adopt Pinia Colada for accessories loading",
      body: "Swap the hand-rolled accessories store for a Pinia Colada query.",
    });
    // The judge reframes into a distinct decision title/body (as the real LLM does) — a decision
    // whose text is byte-identical to its source would be rejected by curate's lexical dedup as a
    // duplicate of that source, so the supersede could never fire.
    const judge = judgeFlagging({
      [src.frontmatter.id]: {
        title: "Standardize customer data loading on Pinia Colada",
        body: "Customer-domain data loading is standardized on Pinia Colada for caching and dedup.",
      },
    });
    const first = await applyReclassify(brainDir, await planReclassify(brainDir, judge));
    expect(first.superseded).toHaveLength(1); // the supersede actually fired

    // Second pass: the source is now superseded, so it drops out of the active-memory scan.
    const plan2 = await planReclassify(brainDir, judge);
    expect(plan2.candidates).toHaveLength(0);
  });
});

describe("reclassify (convenience)", () => {
  it("returns the plan and a null result when apply is not requested", async () => {
    const src = await writeNote(brainDir, { kind: "memory", title: "adopt Z", body: "Z over W." });
    const { plan, result } = await reclassify(
      brainDir,
      judgeFlagging({ [src.frontmatter.id]: true }),
      { apply: false },
    );
    expect(plan.candidates).toHaveLength(1);
    expect(result).toBeNull();
    // Nothing was written.
    expect(await listNotes(brainDir, "decision")).toHaveLength(0);
  });
});
