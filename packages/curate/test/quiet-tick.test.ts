import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  acquireSyncLock,
  checkpointPath,
  initBrain,
  listNotes,
  readCheckpoint,
  setFeature,
  writeNote,
  type Embedder,
} from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consolidateCanon } from "../src/consolidate.js";
import { graduateToOrgBrain } from "../src/graduate.js";
import { listStaged } from "../src/staging.js";

/**
 * Quiet-tick guard on the periodic maintenance passes (#273). The contract under test is the same
 * for both passes: cold start runs fully; an unchanged second run skips the expensive stage and
 * says why; a real change un-skips it; and a pass that fails does NOT advance the checkpoint, so
 * the window it dropped is re-processed on the next tick.
 */

/** Deterministic fake embedder (same shape as graduate.test.ts): same text → same unit vector. */
function fakeEmbedder(dim = 1024): Embedder {
  const norm = (t: string): string =>
    t
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const vecFor = (t: string): Float32Array => {
    let h = 5381;
    for (const ch of norm(t)) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
    const v = new Float32Array(dim);
    v[h % dim] = 1;
    return v;
  };
  return { embed: async (texts) => texts.map(vecFor) };
}

describe("consolidate quiet tick (#273)", () => {
  let brainDir: string;

  beforeEach(async () => {
    brainDir = await fs.mkdtemp(path.join(tmpdir(), "cw-tick-consolidate-"));
    await initBrain(brainDir, { name: "t" });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(brainDir, { recursive: true, force: true });
  });

  /** How many canon memory notes are NOT superseded. */
  async function activeMemories(): Promise<number> {
    const notes = await listNotes(brainDir, "memory");
    return notes.filter((n) => n.frontmatter.status !== "superseded").length;
  }

  it("runs in full on a cold start (no checkpoint) and records one", async () => {
    await writeNote(brainDir, { kind: "memory", title: "Cache TTL", body: "the edge cache is 5m" });
    await writeNote(brainDir, { kind: "memory", title: "Cache TTL", body: "the edge cache is 5m" });
    expect(await readCheckpoint(brainDir, "consolidate")).toBeNull();

    const first = await consolidateCanon(brainDir);
    expect(first.unchangedSince).toBeUndefined();
    expect(first.superseded).toHaveLength(1);
    expect(await readCheckpoint(brainDir, "consolidate")).not.toBeNull();
  });

  it("skips the expensive stage on a second run over unchanged canon, and says nothing changed", async () => {
    await writeNote(brainDir, { kind: "memory", title: "Auth uses JWT", body: "short-lived" });
    // First run finds nothing to merge and settles the checkpoint on the current canon.
    expect((await consolidateCanon(brainDir)).unchangedSince).toBeUndefined();

    const quiet = await consolidateCanon(brainDir);
    // A no-op BECAUSE nothing changed — reported distinctly from the `skipped:` failure path.
    expect(quiet.unchangedSince).toBeTruthy();
    expect(quiet.skipped).toBeUndefined();
    expect(quiet.clusters).toBe(0);
    expect(quiet.superseded).toEqual([]);
  });

  it("does not skip after a real change to canon", async () => {
    await writeNote(brainDir, { kind: "memory", title: "Auth uses JWT", body: "short-lived" });
    await consolidateCanon(brainDir);
    expect((await consolidateCanon(brainDir)).unchangedSince).toBeTruthy();

    // A genuine near-duplicate lands (e.g. pulled from a teammate) — the pass must wake up.
    await writeNote(brainDir, { kind: "memory", title: "Auth uses JWT", body: "short-lived" });
    const woken = await consolidateCanon(brainDir);
    expect(woken.unchangedSince).toBeUndefined();
    expect(woken.superseded).toHaveLength(1);
    expect(await activeMemories()).toBe(1);
  });

  it("--force runs the full pass even on a quiet tick", async () => {
    await writeNote(brainDir, { kind: "memory", title: "Auth uses JWT", body: "short-lived" });
    await consolidateCanon(brainDir);
    expect((await consolidateCanon(brainDir)).unchangedSince).toBeTruthy();

    const forced = await consolidateCanon(brainDir, { force: true });
    expect(forced.unchangedSince).toBeUndefined();
    expect(forced.clusters).toBe(0);
  });

  it("a dry run neither consults nor advances the checkpoint", async () => {
    await writeNote(brainDir, { kind: "memory", title: "Cache TTL", body: "the edge cache is 5m" });
    await writeNote(brainDir, { kind: "memory", title: "Cache TTL", body: "the edge cache is 5m" });

    const preview = await consolidateCanon(brainDir, { dryRun: true });
    expect(preview.superseded).toHaveLength(1); // would supersede
    expect(preview.unchangedSince).toBeUndefined();
    // Crucially, the preview did not mark this window as processed…
    expect(await readCheckpoint(brainDir, "consolidate")).toBeNull();
    // …so the real pass still does the work.
    expect((await consolidateCanon(brainDir)).superseded).toHaveLength(1);
  });

  it("a different threshold is not a quiet tick (it is folded into the fingerprint)", async () => {
    await writeNote(brainDir, { kind: "memory", title: "Auth uses JWT", body: "short-lived" });
    await consolidateCanon(brainDir);
    expect((await consolidateCanon(brainDir)).unchangedSince).toBeTruthy();
    expect((await consolidateCanon(brainDir, { threshold: 0.5 })).unchangedSince).toBeUndefined();
  });

  it("does NOT advance the checkpoint when the pass throws — the window is re-processed", async () => {
    await writeNote(brainDir, { kind: "memory", title: "Cache TTL", body: "the edge cache is 5m" });
    await writeNote(brainDir, { kind: "memory", title: "Cache TTL", body: "the edge cache is 5m" });

    // Fail mid-pass, after the fingerprint is taken and before any checkpoint write.
    const boom = new Error("disk fell over");
    const spy = vi.spyOn(await import("@cmnwlth/core"), "supersedeNote").mockRejectedValue(boom);
    await expect(consolidateCanon(brainDir)).rejects.toThrow("disk fell over");
    expect(await readCheckpoint(brainDir, "consolidate")).toBeNull();

    // Next tick: the checkpoint never moved, so the same duplicate pair is processed for real.
    spy.mockRestore();
    const retry = await consolidateCanon(brainDir);
    expect(retry.unchangedSince).toBeUndefined();
    expect(retry.superseded).toHaveLength(1);
  });
});

describe("graduate quiet tick (#273)", () => {
  let org: string;
  let acme: string;
  let beta: string;

  beforeEach(async () => {
    org = await fs.mkdtemp(path.join(tmpdir(), "cw-tick-org-"));
    acme = await fs.mkdtemp(path.join(tmpdir(), "cw-tick-acme-"));
    beta = await fs.mkdtemp(path.join(tmpdir(), "cw-tick-beta-"));
    for (const [d, name] of [
      [org, "org"],
      [acme, "acme"],
      [beta, "beta"],
    ] as const) {
      await initBrain(d, { name });
    }
  });
  afterEach(async () => {
    for (const d of [org, acme, beta]) await fs.rm(d, { recursive: true, force: true });
  });

  /** Write an opted-in memory note. */
  async function optedIn(dir: string, title: string, body: string, source: string): Promise<void> {
    await writeNote(dir, { kind: "memory", title, body, source, fields: { graduate: true } });
  }

  /** Run a pass with the shared fake embedder over the two project brains. */
  async function run(opts: { force?: boolean; dryRun?: boolean } = {}) {
    return graduateToOrgBrain({
      orgBrainDir: org,
      brainDirs: [acme, beta],
      embedder: fakeEmbedder(),
      ...opts,
    });
  }

  it("runs in full on a cold start, then skips an unchanged second run", async () => {
    await optedIn(acme, "Conventional commits", "use conventional commits everywhere", "acme");
    await optedIn(beta, "Conventional commits", "use conventional commits everywhere", "beta");

    const first = await run();
    expect(first.skipped).toBeUndefined();
    expect(first.staged).toHaveLength(1);
    expect(await readCheckpoint(org, "graduate")).not.toBeNull();

    // Staging the candidate changed the org-brain, so one more run settles the quiet state…
    await run();
    const quiet = await run();
    expect(quiet.unchangedSince).toBeTruthy();
    expect(quiet.skipped).toBeUndefined();
    expect(quiet.clusters).toBe(0);
    // …and nothing was double-staged along the way.
    expect(await listStaged(org)).toHaveLength(1);
  });

  it("wakes up when a project brain changes, and --force overrides the guard", async () => {
    await optedIn(acme, "Trunk based", "we merge to trunk daily", "acme");
    await run();
    expect((await run()).unchangedSince).toBeTruthy();

    // The second brain corroborates the fact — a cross-brain cluster now exists.
    await optedIn(beta, "Trunk based", "we merge to trunk daily", "beta");
    const woken = await run();
    expect(woken.unchangedSince).toBeUndefined();
    expect(woken.clusters).toBe(1);

    await run();
    expect((await run()).unchangedSince).toBeTruthy();
    expect((await run({ force: true })).unchangedSince).toBeUndefined();
  });

  it("keeps its own checkpoint — consolidate settling does not make graduate skip", async () => {
    await optedIn(acme, "Conventional commits", "use conventional commits everywhere", "acme");
    await optedIn(beta, "Conventional commits", "use conventional commits everywhere", "beta");
    // Consolidate the org-brain to a settled checkpoint first.
    await consolidateCanon(org);
    expect((await consolidateCanon(org)).unchangedSince).toBeTruthy();
    expect(await readCheckpoint(org, "graduate")).toBeNull();

    // graduate has never run, so it must still do the work in full.
    const result = await run();
    expect(result.unchangedSince).toBeUndefined();
    expect(result.staged).toHaveLength(1);
  });

  it("does NOT advance the checkpoint when the pass cannot run (no embedder)", async () => {
    await optedIn(acme, "Conventional commits", "use conventional commits everywhere", "acme");
    await optedIn(beta, "Conventional commits", "use conventional commits everywhere", "beta");

    const bailed = await graduateToOrgBrain({
      orgBrainDir: org,
      brainDirs: [acme, beta],
      embedder: null,
    });
    expect(bailed.skipped).toContain("no embedder");
    expect(await readCheckpoint(org, "graduate")).toBeNull();

    // Once a provider exists the SAME window is processed — nothing was silently skipped.
    const recovered = await run();
    expect(recovered.unchangedSince).toBeUndefined();
    expect(recovered.staged).toHaveLength(1);
  });

  it("a dry run neither consults nor advances the checkpoint", async () => {
    await optedIn(acme, "Conventional commits", "use conventional commits everywhere", "acme");
    await optedIn(beta, "Conventional commits", "use conventional commits everywhere", "beta");

    const preview = await run({ dryRun: true });
    expect(preview.clusters).toBe(1);
    expect(preview.staged).toEqual([]);
    expect(await readCheckpoint(org, "graduate")).toBeNull();
    expect((await run()).staged).toHaveLength(1);
  });

  it("does NOT advance the checkpoint when a project brain could not be read (partial pass)", async () => {
    await optedIn(acme, "Conventional commits", "use conventional commits everywhere", "acme");
    await optedIn(beta, "Conventional commits", "use conventional commits everywhere", "beta");

    // beta's own sync lock is held by "another writer", so its notes never enter the pool. The pass
    // completes, but only partially — it must not mark this window as processed.
    const releaseBeta = await acquireSyncLock(beta);
    expect(releaseBeta).not.toBeNull();
    let partial;
    try {
      partial = await run();
    } finally {
      await releaseBeta?.();
    }
    expect(partial.skippedBrains).toHaveLength(1);
    expect(partial.staged).toHaveLength(0); // no cross-brain cluster without beta
    expect(await readCheckpoint(org, "graduate")).toBeNull();

    // Next tick, with beta readable again: the same window is processed rather than skipped.
    const retry = await run();
    expect(retry.unchangedSince).toBeUndefined();
    expect(retry.skippedBrains).toHaveLength(0);
    expect(retry.staged).toHaveLength(1);
  });

  it("wakes up when the org-brain's config changes, even though no note did", async () => {
    await optedIn(acme, "Trunk based", "we merge to trunk daily", "acme");
    await optedIn(beta, "Trunk based", "we merge to trunk daily", "beta");
    await run();
    await run();
    expect((await run()).unchangedSince).toBeTruthy();

    // `autoAdr` decides whether decisions may graduate at all, so flipping it changes the pass's
    // outcome without touching a single note — it must not read as a quiet tick.
    await setFeature(org, "autoAdr", true);
    expect((await run()).unchangedSince).toBeUndefined();
  });

  it("stores its checkpoint in the org-brain's derived index area, never in a project brain", async () => {
    await optedIn(acme, "Conventional commits", "use conventional commits everywhere", "acme");
    await optedIn(beta, "Conventional commits", "use conventional commits everywhere", "beta");
    await run();

    await expect(fs.access(checkpointPath(org, "graduate"))).resolves.toBeUndefined();
    await expect(fs.access(checkpointPath(acme, "graduate"))).rejects.toThrow();
    await expect(fs.access(checkpointPath(beta, "graduate"))).rejects.toThrow();
  });
});
