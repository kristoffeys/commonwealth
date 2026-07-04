import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initBrain, listNotes, writeNote } from "@commonwealth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consolidateCanon } from "../src/consolidate.js";

let brainDir: string;

beforeEach(async () => {
  brainDir = await fs.mkdtemp(path.join(tmpdir(), "commonwealth-consolidate-"));
  await initBrain(brainDir, { name: "t" });
});
afterEach(async () => {
  await fs.rm(brainDir, { recursive: true, force: true });
});

/** How many canon memory notes are NOT superseded. */
async function activeMemories(): Promise<number> {
  const notes = await listNotes(brainDir, "memory");
  return notes.filter((n) => n.frontmatter.status !== "superseded").length;
}

describe("consolidateCanon (#29)", () => {
  it("supersedes a near-duplicate onto a single survivor (supersede-not-delete)", async () => {
    await writeNote(brainDir, {
      kind: "memory",
      title: "Cache TTL",
      body: "the edge cache is five minutes",
    });
    await writeNote(brainDir, {
      kind: "memory",
      title: "Cache TTL",
      body: "the edge cache is five minutes",
    });

    const result = await consolidateCanon(brainDir);
    expect(result.clusters).toBe(1);
    expect(result.superseded).toHaveLength(1);
    // Both files still exist (nothing deleted); exactly one is now superseded.
    expect((await listNotes(brainDir, "memory")).length).toBe(2);
    expect(await activeMemories()).toBe(1);
  });

  it("leaves genuinely distinct notes untouched", async () => {
    await writeNote(brainDir, {
      kind: "memory",
      title: "Auth uses JWT",
      body: "short-lived access tokens",
    });
    await writeNote(brainDir, {
      kind: "memory",
      title: "Billing is monthly",
      body: "invoices go out on the first",
    });
    const result = await consolidateCanon(brainDir);
    expect(result.superseded).toHaveLength(0);
    expect(await activeMemories()).toBe(2);
  });

  it("dry-run reports duplicates without writing", async () => {
    await writeNote(brainDir, {
      kind: "memory",
      title: "Same",
      body: "identical body content here",
    });
    await writeNote(brainDir, {
      kind: "memory",
      title: "Same",
      body: "identical body content here",
    });
    const result = await consolidateCanon(brainDir, { dryRun: true });
    expect(result.superseded).toHaveLength(1); // planned
    expect(await activeMemories()).toBe(2); // …but nothing was actually superseded
  });

  it("is single-writer: no-ops when another process holds the sync lock", async () => {
    await writeNote(brainDir, {
      kind: "memory",
      title: "Same",
      body: "identical body content here",
    });
    await writeNote(brainDir, {
      kind: "memory",
      title: "Same",
      body: "identical body content here",
    });
    // Simulate a live writer holding the lock (this test process's pid is alive).
    const lock = path.join(brainDir, ".commonwealth", "sync.lock");
    await fs.mkdir(path.dirname(lock), { recursive: true });
    await fs.writeFile(lock, `${process.pid}\n`, "utf8");

    const result = await consolidateCanon(brainDir);
    expect(result.skipped).toMatch(/lock/);
    expect(await activeMemories()).toBe(2); // untouched — did not race the lock holder
  });

  it("only touches supersede-able kinds (work-state duplicates are left alone)", async () => {
    await writeNote(brainDir, {
      kind: "work-state",
      title: "Ship v2",
      body: "same workstream text",
      fields: { status: "planned" },
    });
    await writeNote(brainDir, {
      kind: "work-state",
      title: "Ship v2",
      body: "same workstream text",
      fields: { status: "planned" },
    });
    const result = await consolidateCanon(brainDir);
    expect(result.superseded).toHaveLength(0);
  });

  it("keeps the verified survivor over an unverified duplicate", async () => {
    const verified = await writeNote(brainDir, {
      kind: "memory",
      title: "Deploy cadence",
      body: "we deploy on fridays after standup",
      fields: { verified: "2026-07-01" },
    });
    await writeNote(brainDir, {
      kind: "memory",
      title: "Deploy cadence",
      body: "we deploy on fridays after standup",
    });
    const result = await consolidateCanon(brainDir);
    expect(result.superseded).toHaveLength(1);
    // The unverified one was superseded; the verified survivor stays active.
    expect(result.superseded[0]!.survivor).toBe(verified.frontmatter.id);
  });
});
