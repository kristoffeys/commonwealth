import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initBrain, listNotes, setFeature, type NewNoteInput } from "@commonwealth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureCandidates } from "../src/capture.js";
import { listPending } from "../src/review.js";

/**
 * autoPromote (ADR-0014): captured notes land straight in canon by default, skipping the
 * manual review step. Turning the flag off restores the review-queue behavior. Curation
 * gating (dedup/validation) runs either way — autoPromote only skips *manual* review.
 */

let brainDir: string;

const candidates: NewNoteInput[] = [
  {
    kind: "memory",
    title: "Edge cache TTL is five minutes",
    body: "The edge cache holds responses for five minutes before revalidating upstream.",
  },
];

beforeEach(async () => {
  brainDir = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-curate-autopromote-"));
  await initBrain(brainDir, { name: "autopromote-brain" });
});

afterEach(async () => {
  await fs.rm(brainDir, { recursive: true, force: true });
});

describe("captureCandidates autoPromote", () => {
  it("promotes captured notes straight to canon by default (flag defaults on)", async () => {
    const result = await captureCandidates(brainDir, candidates);

    expect(result.staged).toHaveLength(1);
    expect(result.promoted).toHaveLength(1);
    expect(result.promoted[0]).toMatch(/^memory\/.+\.md$/);

    // It reached canon and left nothing behind in the review queue.
    const canon = await listNotes(brainDir);
    expect(canon.map((n) => n.frontmatter.title)).toContain("Edge cache TTL is five minutes");
    expect(await listPending(brainDir)).toHaveLength(0);
  });

  it("holds captured notes in the review queue when autoPromote is off", async () => {
    await setFeature(brainDir, "autoPromote", false);

    const result = await captureCandidates(brainDir, candidates);

    expect(result.staged).toHaveLength(1);
    expect(result.promoted).toHaveLength(0);

    // It is pending review, not yet in canon.
    expect(await listPending(brainDir)).toHaveLength(1);
    expect(await listNotes(brainDir)).toHaveLength(0);
  });
});
