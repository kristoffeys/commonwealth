import { promises as fs } from "node:fs";
import path from "node:path";
import { writeNote } from "@commonwealth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Daemon, isRunning, readPid } from "../src/daemon";
import { git, makeFixture, type Fixture } from "./helpers";

let fx: Fixture;

beforeEach(async () => {
  fx = await makeFixture();
});
afterEach(async () => {
  await fx.cleanup();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("Daemon", () => {
  it("commits and pushes a note created after start, then stops cleanly", async () => {
    const daemon = new Daemon();
    const commitsBefore = git(fx.alice, ["rev-list", "--count", "HEAD"]);

    let synced = 0;
    await daemon.start(fx.alice, {
      intervalMs: 60_000, // rely on the watcher, not the poll, for this test
      debounceMs: 100,
      onSync: () => {
        synced++;
      },
    });

    try {
      // PID file written and the process is reported running.
      expect(await readPid(fx.alice)).toBe(process.pid);
      expect(await isRunning(fx.alice)).toBe(true);

      // Create a note via the note IO after the watcher is live.
      await writeNote(fx.alice, { kind: "memory", title: "Daemon note", body: "watched write" });

      // Wait (tolerantly) for debounce + sync to produce a new commit.
      const deadline = Date.now() + 8_000;
      let commitsAfter = commitsBefore;
      while (Date.now() < deadline) {
        commitsAfter = git(fx.alice, ["rev-list", "--count", "HEAD"]);
        if (Number(commitsAfter) > Number(commitsBefore)) break;
        await sleep(150);
      }
      expect(Number(commitsAfter)).toBeGreaterThan(Number(commitsBefore));
      expect(synced).toBeGreaterThan(0);

      // The note reached the remote (pushed).
      const remoteLog = git(fx.remote, ["log", "--oneline"]);
      expect(remoteLog).toContain("sync local changes");
    } finally {
      await daemon.stop();
    }

    // After stop the PID file is gone.
    expect(await readPid(fx.alice)).toBeNull();
    await expect(fs.access(path.join(fx.alice, ".commonwealth", "sync.pid"))).rejects.toBeTruthy();
  }, 20_000);

  it("refuses to start a second daemon for the same brain (#100)", async () => {
    const first = new Daemon();
    await first.start(fx.alice, { intervalMs: 60_000, debounceMs: 100 });
    try {
      const second = new Daemon();
      // A live daemon already owns this brain → the second must refuse rather than race it.
      await expect(second.start(fx.alice, { intervalMs: 60_000 })).rejects.toThrow(
        /already running/,
      );
    } finally {
      await first.stop();
    }
    // After the first stops, a fresh start is allowed again.
    const third = new Daemon();
    await third.start(fx.alice, { intervalMs: 60_000, debounceMs: 100 });
    await third.stop();
  }, 20_000);

  it("settles after a write and does not self-trigger an unbounded sync loop", async () => {
    // Regression: regenerateDerived rewrites COMMONWEALTH.md/INDEX.md every sync; if the
    // watcher observed those, each sync would retrigger the next forever. They must be
    // ignored so activity stabilizes after a single write.
    const daemon = new Daemon();
    let synced = 0;
    await daemon.start(fx.alice, {
      intervalMs: 60_000, // keep the poll out of this window; test the watcher only
      debounceMs: 100,
      onSync: () => {
        synced++;
      },
    });
    try {
      await writeNote(fx.alice, { kind: "memory", title: "Settle test", body: "x" });
      await sleep(3_000);
      const countA = synced;
      await sleep(3_000);
      const countB = synced;
      // Once settled, no further syncs fire (derived writes don't retrigger).
      expect(countB - countA).toBe(0);
      // And the total stays small (a handful), not the dozens a loop would produce.
      expect(countB).toBeLessThanOrEqual(4);
    } finally {
      await daemon.stop();
    }
  }, 20_000);
});
