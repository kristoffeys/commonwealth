import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initBrain, listNotes, serializeNote, type NewNoteInput } from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureCandidates } from "../src/capture.js";

/**
 * Project identity stamping (ADR-0031). A capture whose candidate carries a declared `project`
 * (a manifest stamped it) + a `customer:<slug>` tag persists both onto the note; a capture without
 * them is byte-identical to today's provenance-only note (the differential fixture).
 */

let brainDir: string;

const base: NewNoteInput = {
  kind: "memory",
  title: "Edge cache TTL is five minutes",
  body: "The edge cache holds responses for five minutes before revalidating upstream.",
  source: "weareantenna/acme-website",
};

beforeEach(async () => {
  brainDir = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-curate-project-"));
  await initBrain(brainDir, { name: "project-brain" });
});
afterEach(async () => {
  await fs.rm(brainDir, { recursive: true, force: true });
});

describe("captureCandidates project stamping", () => {
  it("persists a declared project to frontmatter and the customer tag", async () => {
    const result = await captureCandidates(brainDir, [
      { ...base, project: "acme-engagement", tags: ["customer:acme-corp"] },
    ]);
    expect(result.promoted).toHaveLength(1);

    const [note] = await listNotes(brainDir, "memory");
    expect(note?.frontmatter.project).toBe("acme-engagement");
    expect(note?.frontmatter.tags).toContain("customer:acme-corp");
    // Provenance is untouched — identity is additive, not a rewrite.
    expect(note?.frontmatter.source).toBe("weareantenna/acme-website");
  });

  it("leaves the note free of a `project` field when none is declared (differential fixture)", async () => {
    const result = await captureCandidates(brainDir, [base]);
    expect(result.promoted).toHaveLength(1);

    const [note] = await listNotes(brainDir, "memory");
    expect(note?.frontmatter).not.toHaveProperty("project");
    // The serialized note carries no `project:` line — byte-for-byte the pre-ADR-0031 shape.
    expect(serializeNote(note!)).not.toContain("project:");
  });
});
