import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  contributorPersonId,
  initBrain,
  listNotes,
  setFeature,
  writeNote,
  type ContributorIdentity,
  type NewNoteInput,
} from "@cmnwlth/core";
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

const contributor: ContributorIdentity = {
  name: "Alice Example",
  email: "alice@example.com",
  key: `email-sha256:${createHash("sha256").update("alice@example.com").digest("hex")}`,
};

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

  it("creates one contributor person and links every captured note to it", async () => {
    const first = await captureCandidates(brainDir, candidates, undefined, { contributor });
    const second = await captureCandidates(
      brainDir,
      [
        {
          kind: "memory",
          title: "Deploys require a release owner",
          body: "Every production deployment must have one explicitly named release owner.",
        },
      ],
      undefined,
      { contributor },
    );

    expect(second.contributorPersonId).toBe(first.contributorPersonId);
    const people = await listNotes(brainDir, "person");
    const memories = await listNotes(brainDir, "memory");
    expect(people).toHaveLength(1);
    expect(memories).toHaveLength(2);
    for (const memory of memories) {
      expect(memory.frontmatter.author).toBe("Alice Example");
      expect(memory.frontmatter.author_ref).toBe(people[0]!.frontmatter.id);
      expect(memory.frontmatter.relates).toContain(people[0]!.frontmatter.id);
    }
  });

  it("does not create a contributor person when curation rejects every candidate", async () => {
    const result = await captureCandidates(
      brainDir,
      [{ kind: "memory", title: "Too thin", body: "short" }],
      undefined,
      { contributor },
    );

    expect(result.rejected).toHaveLength(1);
    expect(result.contributorPersonId).toBeUndefined();
    expect(await listNotes(brainDir, "person")).toHaveLength(0);
  });

  it("converges concurrent name-only and email-backed first writes", async () => {
    await setFeature(brainDir, "autoPromote", false);
    const nameOnly: ContributorIdentity = {
      name: contributor.name,
      key: `name:${contributor.name.toLowerCase()}`,
    };

    await Promise.all([
      captureCandidates(
        brainDir,
        [
          {
            kind: "memory",
            title: "Concurrent fact one",
            body: "The first concurrently captured fact remains linked after convergence.",
          },
        ],
        undefined,
        { contributor: nameOnly },
      ),
      captureCandidates(
        brainDir,
        [
          {
            kind: "memory",
            title: "Concurrent fact two",
            body: "The second concurrently captured fact remains linked after convergence.",
          },
        ],
        undefined,
        { contributor },
      ),
    ]);

    const people = await listNotes(brainDir, "person");
    const pending = await listPending(brainDir);
    expect(people).toHaveLength(1);
    expect(pending).toHaveLength(2);
    for (const note of pending) {
      expect(note.frontmatter.author_ref).toBe(people[0]!.frontmatter.id);
      expect(note.frontmatter.relates).toContain(people[0]!.frontmatter.id);
    }
  });

  it("rolls staged notes back when the contributor record cannot be finalized", async () => {
    await setFeature(brainDir, "autoPromote", false);
    await writeNote(brainDir, {
      id: contributorPersonId(contributor),
      kind: "person",
      title: "Conflicting Identity",
      body: "Occupies the deterministic contributor path with a different identity.",
      fields: { name: "Conflicting Identity", attribution_key: "name:conflicting identity" },
    });

    await expect(
      captureCandidates(brainDir, candidates, undefined, { contributor }),
    ).rejects.toThrow("id collision");
    expect(await listPending(brainDir)).toHaveLength(0);
  });
});
