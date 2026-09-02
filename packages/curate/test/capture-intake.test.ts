import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initBrain, listNotes, noteIntake, serializeNote, type NewNoteInput } from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureCandidates } from "../src/capture.js";

/**
 * Ingestion trust tier stamping at capture (ADR-0038, #274). The tier is declared ONCE per run by
 * the trusted caller; a candidate never declares its own. A run with no declared tier writes notes
 * byte-identical to pre-ADR-0038 ones (the differential fixture).
 */

let brainDir: string;

const base: NewNoteInput = {
  kind: "memory",
  title: "Acme invoices are split per cost centre",
  body: "Acme requires every invoice to be split per cost centre before it can be approved.",
  source: "weareantenna/acme-website",
};

beforeEach(async () => {
  brainDir = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-curate-intake-"));
  await initBrain(brainDir, { name: "intake-brain" });
});
afterEach(async () => {
  await fs.rm(brainDir, { recursive: true, force: true });
});

describe("captureCandidates intake stamping", () => {
  it("stamps every candidate of an externally-ingested run", async () => {
    const result = await captureCandidates(brainDir, [base], undefined, { intake: "external" });
    expect(result.promoted).toHaveLength(1);

    const [note] = await listNotes(brainDir, "memory");
    expect(note?.frontmatter.intake).toBe("external");
    // Provenance and identity are untouched — the tier is a separate axis (ADR-0038).
    expect(note?.frontmatter.source).toBe("weareantenna/acme-website");
  });

  it("leaves the note free of an `intake` field on the ordinary session path", async () => {
    const result = await captureCandidates(brainDir, [base]);
    expect(result.promoted).toHaveLength(1);

    const [note] = await listNotes(brainDir, "memory");
    expect(note?.frontmatter).not.toHaveProperty("intake");
    expect(serializeNote(note!)).not.toContain("intake:");
    // Absence is the internal tier, recorded by documented absence rather than a written value.
    expect(noteIntake(note!.frontmatter)).toBe("internal");
  });

  it("ignores a tier a candidate declares for itself, in both directions", async () => {
    // The failure this guards: a candidate extracted FROM external content claims to be internal
    // and reviews as if a teammate had reasoned it out. The run's tier is authoritative.
    await captureCandidates(brainDir, [{ ...base, intake: "internal" }], undefined, {
      intake: "external",
    });
    const [downgraded] = await listNotes(brainDir, "memory");
    expect(downgraded?.frontmatter.intake).toBe("external");

    // And the reverse: a candidate cannot mark itself external on an internal run either — the
    // tier is not a field the extraction layer gets a vote on.
    await captureCandidates(brainDir, [
      { ...base, title: "Acme approvals need two signatories", intake: "external" },
    ]);
    const escalated = (await listNotes(brainDir, "memory")).find(
      (n) => n.frontmatter.title === "Acme approvals need two signatories",
    );
    expect(escalated?.frontmatter).not.toHaveProperty("intake");
  });

  it("does not change what the gate or autoPromote do to an external candidate (deferred policy)", async () => {
    // ADR-0038 commits to RECORDING the tier, not to policing it: an external candidate still
    // clears the same deterministic gate and still auto-promotes. Locking this in so a future
    // policy change is a deliberate, visible edit to this expectation.
    const result = await captureCandidates(brainDir, [base], undefined, { intake: "external" });
    expect(result.promoted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);

    // The gate itself is still fully in force for an external run — a too-thin candidate is
    // rejected exactly as it would be internally.
    const thin = await captureCandidates(
      brainDir,
      [{ ...base, title: "x", body: "too short" }],
      undefined,
      {
        intake: "external",
      },
    );
    expect(thin.staged).toHaveLength(0);
    expect(thin.rejected[0]?.reason).toBe("too-thin");
  });
});
