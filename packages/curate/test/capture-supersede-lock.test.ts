import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireSyncLock,
  initBrain,
  listNotes,
  readNote,
  readReceipts,
  writeNote,
} from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureCandidates } from "../src/capture.js";
import type { AnnotatedCandidate } from "../src/verdict.js";

/**
 * Capture's supersession runs under the cross-process sync lock (#281).
 *
 * Everything else capture writes is atomic by construction — a new note is its own collision-proof
 * file, so concurrent captures union-merge (ADR-0003). `supersedeNote` is the exception: it is a
 * read-modify-write of a note that ALREADY exists, so two unsynchronised processes are plain
 * last-write-wins, with no conflict, no sibling file, and no warning. That is precisely the
 * "never silently overwrite" invariant ADR-0003 exists to protect, and it is on the DEFAULT path
 * (the supersession block is guarded by `autoPromote`, which defaults on — ADR-0014).
 *
 * The three properties these tests pin down:
 *   1. concurrent supersessions of the same target never disagree with what is on disk;
 *   2. a contended lock DEFERS and REPORTS (result + persisted receipt) — it never drops silently;
 *   3. a throw mid-loop still releases the lock, so one bad capture can't wedge every later writer.
 */

let brainDir: string;

const TARGET_ID = "2026-07-01-jwt-a1";

/** A body comfortably past the relevance floor, so the deterministic gate keeps the candidate. */
const body = (s: string) => `${s} — a body comfortably past the fifteen character floor.`;

/** One candidate that supersedes the seeded target. */
function superseder(title: string, text: string): AnnotatedCandidate {
  return {
    kind: "memory",
    title,
    body: body(text),
    verdict: { consolidation: "supersedes", targetId: TARGET_ID },
  };
}

async function targetStatus(): Promise<{ status?: string; superseded_by?: string }> {
  const fm = (await readNote(brainDir, `memory/${TARGET_ID}.md`)).frontmatter as Record<
    string,
    unknown
  >;
  return { status: fm.status as string, superseded_by: fm.superseded_by as string };
}

beforeEach(async () => {
  brainDir = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-supersede-lock-"));
  await initBrain(brainDir, { name: "supersede-lock-brain" });
  await writeNote(brainDir, {
    id: TARGET_ID,
    kind: "memory",
    title: "Auth uses JWT",
    body: body("we issue 15m JWT access tokens"),
  });
});

afterEach(async () => {
  await fs.rm(brainDir, { recursive: true, force: true });
});

describe("capture supersession is single-writer (#281)", () => {
  it("two concurrent captures superseding one target never disagree with disk", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const [a, b] = await Promise.all([
      captureCandidates(brainDir, [
        superseder("Auth moved to opaque sessions", "we replaced JWT with server-side sessions"),
      ]),
      captureCandidates(brainDir, [
        superseder("Gateway now mints paseto tokens", "the edge gateway issues paseto v4 tokens"),
      ]),
    ]);
    err.mockRestore();

    // Both facts reached canon regardless of who won the lock — a supersession is a consolidation
    // nicety, and losing it must never cost a note.
    const canon = await listNotes(brainDir);
    for (const r of [a, b]) expect(r.promoted).toHaveLength(1);

    // Every attempted supersession is accounted for EXACTLY once: applied, or deferred. Nothing
    // falls between the two — that gap is the bug.
    const applied = [...a.superseded, ...b.superseded];
    const deferred = [...a.supersessionsDeferred, ...b.supersessionsDeferred];
    expect(applied.length + deferred.length).toBe(2);

    // …and the crux: what capture REPORTED as applied is what the target actually says. Before the
    // lock, two blind read-modify-writes both reported success while only the last one landed.
    const { status, superseded_by } = await targetStatus();
    expect(applied).toHaveLength(1);
    expect(deferred).toHaveLength(1);
    expect(status).toBe("superseded");
    expect(superseded_by).toBe(applied[0]!.id);

    // The deferred side's note is in canon and still carries its forward `supersedes` link, so the
    // consolidation intent survives even though the backward link was skipped.
    const deferredNote = canon.find((n) => n.frontmatter.id === deferred[0]!.id)!;
    expect((deferredNote.frontmatter as Record<string, unknown>).supersedes).toEqual([TARGET_ID]);
  });

  it("a contended lock defers the supersession and reports it with a receipt", async () => {
    // Stand in for another process mid-sync. `acquireSyncLock` treats a live owner pid as held.
    const release = (await acquireSyncLock(brainDir))!;
    expect(release).toBeTruthy();

    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await captureCandidates(brainDir, [
      superseder("Auth moved to opaque sessions", "we replaced JWT with server-side sessions"),
    ]);
    const logged = err.mock.calls.flat().join(" ");
    err.mockRestore();
    await release();

    // The note still landed — only the older note's backward link was skipped.
    expect(result.promoted).toHaveLength(1);
    expect(result.superseded).toHaveLength(0);
    expect(result.supersessionsDeferred).toEqual([{ id: expect.any(String), targetId: TARGET_ID }]);
    expect(await targetStatus()).toMatchObject({ status: "active" });

    // Reported, not dropped: the in-process result dies with the detached SessionEnd worker, so the
    // durable half is the receipt `doctor`/`status` read afterwards (ADR-0039, #266).
    const receipts = await readReceipts(brainDir);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      category: "supersession-deferred",
      recoverable: true,
      reason: "supersede-lock-contended",
      title: "Auth moved to opaque sessions",
      kind: "memory",
    });
    expect(receipts[0]!.cause).toContain(TARGET_ID);
    expect(receipts[0]!.nextAction).toBeTruthy();

    // It also said so out loud at the moment it happened.
    expect(logged).toContain("another writer holds the sync lock");
  });

  it("releases the lock when a supersession throws mid-loop", async () => {
    const boom = new Error("disk fell over");
    const spy = vi.spyOn(await import("@cmnwlth/core"), "supersedeNote").mockRejectedValue(boom);

    await expect(
      captureCandidates(brainDir, [
        superseder("Auth moved to opaque sessions", "we replaced JWT with server-side sessions"),
      ]),
    ).rejects.toThrow("disk fell over");
    spy.mockRestore();

    // The `finally` ran: the next writer can still take the lock. Without it the brain would be
    // wedged for every later capture, sync and consolidation in this process's lifetime.
    const release = await acquireSyncLock(brainDir);
    expect(release).not.toBeNull();
    await release!();
  });

  it("takes no lock at all when there is nothing to supersede", async () => {
    // The overwhelmingly common capture has no consolidation verdict; it must not contend with a
    // running sync for a lock it has no use for.
    const release = (await acquireSyncLock(brainDir))!;
    const result = await captureCandidates(brainDir, [
      { kind: "memory", title: "Plain fact", body: body("a durable fact with no verdict") },
    ]);
    await release();

    expect(result.promoted).toHaveLength(1);
    expect(result.supersessionsDeferred).toHaveLength(0);
    expect(await readReceipts(brainDir)).toHaveLength(0);
  });
});
