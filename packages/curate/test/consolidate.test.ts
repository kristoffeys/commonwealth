import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initBrain, listNotes, setFeature, writeNote } from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consolidateCanon,
  DEFAULT_GATE_MIN_SESSIONS,
  isConsolidationDue,
  maybeConsolidate,
  noteConsolidationSession,
  recordConsolidationCheck,
} from "../src/consolidate.js";

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

describe("periodic consolidation gate (ADR-0046, #319)", () => {
  it("is not due below the session threshold, even with no prior check", async () => {
    for (let i = 0; i < DEFAULT_GATE_MIN_SESSIONS - 1; i++)
      await noteConsolidationSession(brainDir);
    expect(await isConsolidationDue(brainDir)).toBe(false);
  });

  it("is due once enough sessions have passed and there is no prior check", async () => {
    for (let i = 0; i < DEFAULT_GATE_MIN_SESSIONS; i++) await noteConsolidationSession(brainDir);
    expect(await isConsolidationDue(brainDir)).toBe(true);
  });

  it("stays in cooldown after a check even once enough sessions pass again", async () => {
    for (let i = 0; i < DEFAULT_GATE_MIN_SESSIONS; i++) await noteConsolidationSession(brainDir);
    const now = Date.now();
    await recordConsolidationCheck(brainDir, now);
    for (let i = 0; i < DEFAULT_GATE_MIN_SESSIONS; i++) await noteConsolidationSession(brainDir);
    // Well within the 24h cooldown.
    expect(await isConsolidationDue(brainDir, { now: now + 60_000 })).toBe(false);
  });

  it("is due again once the cooldown elapses AND enough sessions have passed", async () => {
    const now = Date.now();
    await recordConsolidationCheck(brainDir, now);
    for (let i = 0; i < DEFAULT_GATE_MIN_SESSIONS; i++) await noteConsolidationSession(brainDir);
    expect(await isConsolidationDue(brainDir, { now: now + 25 * 60 * 60 * 1000 })).toBe(true);
  });

  it("a corrupt/missing gate file fails toward NOT due (never toward always-due)", async () => {
    await fs.mkdir(path.join(brainDir, "index"), { recursive: true });
    await fs.writeFile(path.join(brainDir, "index", "consolidate-gate.json"), "not json", "utf8");
    expect(await isConsolidationDue(brainDir)).toBe(false);
  });
});

describe("maybeConsolidate (ADR-0046, #319)", () => {
  async function makeDuplicateCluster() {
    await writeNote(brainDir, { kind: "memory", title: "Cache TTL", body: "edge cache is 5 min" });
    await writeNote(brainDir, { kind: "memory", title: "Cache TTL", body: "edge cache is 5 min" });
  }

  it("does not attempt a pass when the gate isn't due", async () => {
    await makeDuplicateCluster();
    const outcome = await maybeConsolidate(brainDir);
    expect(outcome).toEqual({ ran: false });
    expect(await activeMemories()).toBe(2); // nothing touched
  });

  it("applies supersessions for real when autoPromote is on (default) and the gate is due", async () => {
    await makeDuplicateCluster();
    for (let i = 0; i < DEFAULT_GATE_MIN_SESSIONS; i++) await noteConsolidationSession(brainDir);
    const outcome = await maybeConsolidate(brainDir);
    expect(outcome.ran).toBe(true);
    expect(outcome.pending).toBeFalsy();
    expect(outcome.result?.superseded).toHaveLength(1);
    expect(await activeMemories()).toBe(1); // actually mutated canon
  });

  it("only reports a plan (dry-run) when autoPromote is off, never mutating canon", async () => {
    await setFeature(brainDir, "autoPromote", false);
    await makeDuplicateCluster();
    for (let i = 0; i < DEFAULT_GATE_MIN_SESSIONS; i++) await noteConsolidationSession(brainDir);
    const outcome = await maybeConsolidate(brainDir);
    expect(outcome.ran).toBe(true);
    expect(outcome.pending).toBe(true);
    expect(outcome.result?.clusters).toBe(1);
    expect(await activeMemories()).toBe(2); // NOT mutated — staged for review, not applied
  });

  it("never runs at all when autoConsolidate is off, regardless of the gate", async () => {
    await setFeature(brainDir, "autoConsolidate", false);
    await makeDuplicateCluster();
    for (let i = 0; i < DEFAULT_GATE_MIN_SESSIONS; i++) await noteConsolidationSession(brainDir);
    const outcome = await maybeConsolidate(brainDir);
    expect(outcome).toEqual({ ran: false });
    expect(await activeMemories()).toBe(2);
  });

  it("skips rather than blocking or racing when another writer holds the sync lock", async () => {
    await makeDuplicateCluster();
    for (let i = 0; i < DEFAULT_GATE_MIN_SESSIONS; i++) await noteConsolidationSession(brainDir);
    const lock = path.join(brainDir, ".commonwealth", "sync.lock");
    await fs.mkdir(path.dirname(lock), { recursive: true });
    await fs.writeFile(lock, `${process.pid}\n`, "utf8");

    const outcome = await maybeConsolidate(brainDir);
    expect(outcome.ran).toBe(true);
    expect(outcome.result?.skipped).toMatch(/lock/);
    expect(await activeMemories()).toBe(2); // untouched
  });

  it("never deletes a note even when it supersedes it", async () => {
    await makeDuplicateCluster();
    for (let i = 0; i < DEFAULT_GATE_MIN_SESSIONS; i++) await noteConsolidationSession(brainDir);
    await maybeConsolidate(brainDir);
    expect((await listNotes(brainDir, "memory")).length).toBe(2); // both files still exist
  });

  it("fails open (never throws) when the brain path itself is unusable", async () => {
    const bogus = path.join(brainDir, "does", "not", "exist");
    await expect(maybeConsolidate(bogus)).resolves.toEqual({ ran: false });
  });
});
