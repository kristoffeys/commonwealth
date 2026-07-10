import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeNote } from "../src/notes";
import {
  computeBrainStatus,
  formatStatusLine,
  readStatusCache,
  refreshBrainStatus,
  statusCachePath,
  writeBrainStatus,
} from "../src/status";

describe("formatStatusLine (#197)", () => {
  it("renders brain · score · pending · sync when all present", () => {
    const line = formatStatusLine({
      brain: "acme-brain",
      status: { brain: "acme-brain", brainDir: "/b", score: 87, total: 42, pending: 3, ts: 1 },
      syncing: true,
    });
    expect(line).toBe("🧠 acme-brain · 87/100 · 3 pending · ⇅");
  });

  it("omits pending when zero (nothing to nag about)", () => {
    const line = formatStatusLine({
      brain: "acme-brain",
      status: { brain: "acme-brain", brainDir: "/b", score: 90, total: 10, pending: 0, ts: 1 },
      syncing: false,
    });
    expect(line).toBe("🧠 acme-brain · 90/100");
  });

  it("shows just the name when the cache is cold (no status)", () => {
    expect(formatStatusLine({ brain: "acme-brain", status: null })).toBe("🧠 acme-brain");
  });

  it("appends the sync glyph even when the cache is cold", () => {
    expect(formatStatusLine({ brain: "acme", status: null, syncing: true })).toBe("🧠 acme · ⇅");
  });
});

describe("status cache path", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("honors $COMMONWEALTH_STATUS, then a status.json beside $COMMONWEALTH_CONFIG", () => {
    process.env.COMMONWEALTH_STATUS = "/tmp/custom-status.json";
    expect(statusCachePath()).toBe("/tmp/custom-status.json");

    delete process.env.COMMONWEALTH_STATUS;
    process.env.COMMONWEALTH_CONFIG = "/home/x/.commonwealth/config.json";
    expect(statusCachePath()).toBe(path.join("/home/x/.commonwealth", "status.json"));
  });
});

describe("computeBrainStatus + cache round-trip (from disk)", () => {
  let dir: string;
  let cache: string;
  const saved = { ...process.env };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-status-"));
    cache = path.join(dir, "status.json");
    process.env.COMMONWEALTH_STATUS = cache;
  });
  afterEach(async () => {
    process.env = { ...saved };
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("counts canon and pending (staging) separately", async () => {
    await writeNote(dir, { kind: "memory", title: "Canon fact", body: "b" });
    await writeNote(dir, { kind: "decision", title: "Canon call", body: "b" });
    // A staged (pending-review) note lives under `staging/` — not canon.
    await writeNote(path.join(dir, "staging"), {
      kind: "memory",
      title: "Pending fact",
      body: "b",
    });

    const s = await computeBrainStatus(dir, 12345);
    expect(s.total).toBe(2); // canon only
    expect(s.pending).toBe(1); // staging only
    expect(s.brainDir).toBe(dir);
    expect(s.ts).toBe(12345);
    expect(s.score).toBeGreaterThanOrEqual(0);
    expect(s.score).toBeLessThanOrEqual(100);
    expect(typeof s.brain).toBe("string");
  });

  it("refreshBrainStatus persists to the cache keyed by brain dir, merging other brains", async () => {
    await writeBrainStatus({
      brain: "other",
      brainDir: "/some/other/brain",
      score: 50,
      total: 5,
      pending: 0,
      ts: 1,
    });
    await writeNote(dir, { kind: "memory", title: "x", body: "b" });
    const s = await refreshBrainStatus(dir, 999);

    const loaded = await readStatusCache();
    expect(loaded[dir]).toEqual(s);
    // The pre-existing entry for another brain is preserved (per-brain keying).
    expect(loaded["/some/other/brain"]?.brain).toBe("other");
  });

  it("readStatusCache returns {} when the cache is absent", async () => {
    expect(await readStatusCache()).toEqual({});
  });
});
