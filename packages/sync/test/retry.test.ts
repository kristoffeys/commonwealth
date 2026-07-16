import { promises as fs } from "node:fs";
import path from "node:path";
import { listNotes, writeNote } from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireSyncLock } from "../src/lock";
import { SyncEngine, syncOnceWithRetry } from "../src/engine";
import { git, makeFixture, type Fixture } from "./helpers";

/**
 * The daemonless lifecycle-sync discipline (ADR-0032): a lock-contended pass reports
 * `skippedLocked`, and {@link syncOnceWithRetry} backs off and retries so a loser flushes its own
 * changes in the same round rather than deferring. These run against the same bare-remote fixture
 * the engine tests use, with SEPARATE engines standing in for two independent OS processes.
 */
let fx: Fixture;

beforeEach(async () => {
  fx = await makeFixture();
});
afterEach(async () => {
  await fx.cleanup();
});

describe("syncOnceWithRetry — lock arbitration (ADR-0032)", () => {
  it("retries with backoff while another live process holds the lock, then flushes", async () => {
    const engine = new SyncEngine(fx.alice);
    await writeNote(fx.alice, { kind: "memory", title: "Deferred", body: "waits for the lock" });

    // Hold the cross-process lock as if a peer sync were mid-flight (owner = this live process).
    const lockFile = path.join(fx.alice, ".commonwealth", "sync.lock");
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    await fs.writeFile(lockFile, `${process.pid}\n`, "utf8");

    const retries: number[] = [];
    let released = false;
    const run = syncOnceWithRetry(engine, {
      attempts: 8,
      backoffMs: 5,
      onRetry: (attempt) => {
        retries.push(attempt);
        // Release the lock after a couple of observed retries so the pass can then proceed.
        if (retries.length >= 2 && !released) {
          released = true;
          void fs.rm(lockFile, { force: true });
        }
      },
    });

    const { summary, attempts } = await run;
    // Bounded retries were observed, then the pass committed + pushed the deferred note.
    expect(retries.length).toBeGreaterThanOrEqual(2);
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThanOrEqual(8);
    expect(summary.skippedLocked).toBe(false);
    expect(summary.committed).toBe(true);
  });

  it("gives up (deferring) after a bounded number of attempts when the lock never frees", async () => {
    const engine = new SyncEngine(fx.alice);
    await writeNote(fx.alice, { kind: "memory", title: "Never", body: "lock never frees" });

    // A live owner that we never release — every attempt is contended.
    const lockFile = path.join(fx.alice, ".commonwealth", "sync.lock");
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    await fs.writeFile(lockFile, `${process.pid}\n`, "utf8");

    const { summary, attempts } = await syncOnceWithRetry(engine, { attempts: 4, backoffMs: 1 });
    expect(attempts).toBe(4); // bounded — no unbounded spin
    expect(summary.skippedLocked).toBe(true); // still deferred; caller flushes next SessionStart
    expect(summary.committed).toBe(false);
  });

  it("two concurrent syncs on one brain both land in the remote, with no corruption", async () => {
    // Two engines with independent queues model two OS processes (two session-ends) on ONE brain.
    const engineA = new SyncEngine(fx.alice);
    const engineB = new SyncEngine(fx.alice);

    // Each writes its OWN one-fact note (collision-proof ids, ADR-0003), then both sync at once.
    await writeNote(fx.alice, { kind: "memory", title: "Fact A", body: "from process A" });
    await writeNote(fx.alice, { kind: "memory", title: "Fact B", body: "from process B" });

    // Real git ops take seconds, so give the loser a budget comfortably longer than one pass.
    const [ra, rb] = await Promise.all([
      syncOnceWithRetry(engineA, { attempts: 50, backoffMs: 100 }),
      syncOnceWithRetry(engineB, { attempts: 50, backoffMs: 100 }),
    ]);
    // Neither ended up deferred, and neither exceeded the (bounded) retry budget.
    expect(ra.summary.skippedLocked).toBe(false);
    expect(rb.summary.skippedLocked).toBe(false);
    expect(ra.attempts).toBeLessThanOrEqual(50);
    expect(rb.attempts).toBeLessThanOrEqual(50);
    // At least one of the two had to retry — they genuinely contended the lock.
    expect(Math.max(ra.attempts, rb.attempts)).toBeGreaterThan(1);

    // No stranded rebase / lock left behind, and both notes are committed locally.
    await expect(fs.access(path.join(fx.alice, ".commonwealth", "sync.lock"))).rejects.toThrow();
    const localBodies = (await listNotes(fx.alice, "memory")).map((n) => n.body).sort();
    expect(localBodies).toEqual(["from process A", "from process B"]);

    // Both notes reached the bare remote: a fresh clone sees them.
    const verify = path.join(path.dirname(fx.remote), "verify");
    git(path.dirname(fx.remote), ["clone", "-q", fx.remote, verify]);
    const remoteBodies = (await listNotes(verify, "memory")).map((n) => n.body).sort();
    expect(remoteBodies).toEqual(["from process A", "from process B"]);
  });

  it("resolves immediately (one attempt) for a genuine no-op, not a lock-skip", async () => {
    const engine = new SyncEngine(fx.bob);
    // Bob has nothing to commit and is up to date — a true no-op, never a lock-skip.
    const { summary, attempts } = await syncOnceWithRetry(engine, { attempts: 5, backoffMs: 50 });
    // Resolves in ONE attempt (no lock contention → no retry), and is not flagged as lock-skipped.
    expect(attempts).toBe(1);
    expect(summary.skippedLocked).toBe(false);
  });

  it("acquireSyncLock still returns null to a peer while a live owner holds it", async () => {
    // Direct guard on the primitive the retry loop depends on.
    const release = await acquireSyncLock(fx.alice);
    expect(release).not.toBeNull();
    expect(await acquireSyncLock(fx.alice)).toBeNull();
    await release!();
    const again = await acquireSyncLock(fx.alice);
    expect(again).not.toBeNull();
    await again!();
  });
});
