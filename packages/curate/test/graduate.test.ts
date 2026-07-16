import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  initBrain,
  listNotes,
  regenerateDerived,
  setFeature,
  verifyBrain,
  writeNote,
  type Embedder,
} from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { graduateToOrgBrain } from "../src/graduate.js";
import { reject } from "../src/review.js";
import { listStaged } from "../src/staging.js";
import { loadTombstonedKeys, tombstonePath } from "../src/tombstone.js";

// Org-brain graduation (#110, ADR-0023): detect facts recurring across ≥2 project brains and stage
// them into the org-brain for manual review.

/**
 * Deterministic fake embedder: identical (normalized) text → identical one-hot unit vector, so
 * cosine is 1.0 for the same fact and ~0 for different facts. Lets the cross-brain clustering be
 * tested without the optional local model. Passed to graduate (which forwards it to buildIndex).
 */
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

let org: string;
let acme: string;
let beta: string;

beforeEach(async () => {
  org = await fs.mkdtemp(path.join(tmpdir(), "cw-grad-org-"));
  acme = await fs.mkdtemp(path.join(tmpdir(), "cw-grad-acme-"));
  beta = await fs.mkdtemp(path.join(tmpdir(), "cw-grad-beta-"));
  await initBrain(org, { name: "org" });
  await initBrain(acme, { name: "acme" });
  await initBrain(beta, { name: "beta" });
});
afterEach(async () => {
  for (const d of [org, acme, beta]) await fs.rm(d, { recursive: true, force: true });
});

/** Write an opted-in memory note; `graduate:false` unless overridden. */
async function optedIn(dir: string, title: string, body: string, source: string): Promise<void> {
  await writeNote(dir, { kind: "memory", title, body, source, fields: { graduate: true } });
}

describe("graduateToOrgBrain (#110)", () => {
  it("stages one candidate for a fact recurring across two brains, with back-links to both", async () => {
    await optedIn(acme, "Conventional commits", "use conventional commits on every repo", "acme");
    await optedIn(beta, "Conventional commits", "use conventional commits on every repo", "beta");

    const result = await graduateToOrgBrain({
      orgBrainDir: org,
      brainDirs: [acme, beta],
      embedder: fakeEmbedder(),
    });

    expect(result.skipped).toBeUndefined();
    expect(result.clusters).toBe(1);
    expect(result.staged).toHaveLength(1);
    // The candidate carries `sources:` back-links to BOTH originating notes.
    const staged = await listStaged(org);
    expect(staged).toHaveLength(1);
    const sources = (staged[0]!.frontmatter as { sources?: string[] }).sources ?? [];
    expect(sources.some((s) => s.startsWith("acme/"))).toBe(true);
    expect(sources.some((s) => s.startsWith("beta/"))).toBe(true);
    expect(result.candidates[0]!.brains).toHaveLength(2);
  });

  it("does not graduate a fact present in only ONE brain", async () => {
    await optedIn(acme, "Acme-only rule", "acme invoices round half-up", "acme");
    await optedIn(beta, "Unrelated", "beta uses feature flags heavily", "beta");

    const result = await graduateToOrgBrain({
      orgBrainDir: org,
      brainDirs: [acme, beta],
      embedder: fakeEmbedder(),
    });
    expect(result.clusters).toBe(0);
    expect(await listStaged(org)).toHaveLength(0);
  });

  it("ignores notes that are not opted in (graduate !== true)", async () => {
    // Same fact in both brains, but NOT marked graduate: true → must never leave its repo.
    await writeNote(acme, {
      kind: "memory",
      title: "Secret sauce",
      body: "same recipe",
      source: "acme",
    });
    await writeNote(beta, {
      kind: "memory",
      title: "Secret sauce",
      body: "same recipe",
      source: "beta",
    });

    const result = await graduateToOrgBrain({
      orgBrainDir: org,
      brainDirs: [acme, beta],
      embedder: fakeEmbedder(),
    });
    expect(result.clusters).toBe(0);
    expect(await listStaged(org)).toHaveLength(0);
  });

  it("requires ≥2 DISTINCT brains — a fact repeated within one brain does not graduate", async () => {
    await optedIn(acme, "Repeated", "the same fact twice", "acme");
    await optedIn(acme, "Repeated", "the same fact twice", "acme");

    const result = await graduateToOrgBrain({
      orgBrainDir: org,
      brainDirs: [acme, beta],
      embedder: fakeEmbedder(),
    });
    expect(result.clusters).toBe(0);
    expect(await listStaged(org)).toHaveLength(0);
  });

  it("dry-run reports the candidate but stages nothing", async () => {
    await optedIn(acme, "Shared infra", "we deploy on fly.io", "acme");
    await optedIn(beta, "Shared infra", "we deploy on fly.io", "beta");

    const result = await graduateToOrgBrain({
      orgBrainDir: org,
      brainDirs: [acme, beta],
      embedder: fakeEmbedder(),
      dryRun: true,
    });
    expect(result.clusters).toBe(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.staged).toHaveLength(0);
    expect(await listStaged(org)).toHaveLength(0);
  });

  it("stays in staging even when the org-brain has autoPromote=true (manual review by default)", async () => {
    await setFeature(org, "autoPromote", true);
    await optedIn(acme, "Shared rule", "prefer async communication", "acme");
    await optedIn(beta, "Shared rule", "prefer async communication", "beta");

    const result = await graduateToOrgBrain({
      orgBrainDir: org,
      brainDirs: [acme, beta],
      embedder: fakeEmbedder(),
    });
    // Staged for review, NOT promoted to canon — curate() never auto-promotes.
    expect(result.staged).toHaveLength(1);
    expect(await listStaged(org)).toHaveLength(1);
    expect(await listNotes(org, "memory")).toHaveLength(0);
  });

  it("skips cleanly when no org-brain is designated", async () => {
    const result = await graduateToOrgBrain({
      registryPath: path.join(org, "does-not-exist-registry.json"),
      embedder: fakeEmbedder(),
    });
    expect(result.skipped).toMatch(/no org-brain/i);
    expect(result.staged).toHaveLength(0);
  });
});

describe("graduateToOrgBrain — reject-tombstones (#172)", () => {
  /** Stage a cross-brain candidate into the org, then reject it (writing its tombstone). */
  async function stageThenReject(): Promise<void> {
    const first = await graduateToOrgBrain({
      orgBrainDir: org,
      brainDirs: [acme, beta],
      embedder: fakeEmbedder(),
    });
    expect(first.staged).toHaveLength(1);
    const staged = await listStaged(org);
    await reject(org, staged[0]!.frontmatter.id);
    expect(await loadTombstonedKeys(org)).toHaveLength(1);
  }

  it("does not re-stage a rejected candidate on the next run; reports the suppressed count", async () => {
    await optedIn(acme, "Conventional commits", "use conventional commits on every repo", "acme");
    await optedIn(beta, "Conventional commits", "use conventional commits on every repo", "beta");

    await stageThenReject();

    // Next run: the cluster is detected again but skipped — nothing re-stages, and it's counted.
    const again = await graduateToOrgBrain({
      orgBrainDir: org,
      brainDirs: [acme, beta],
      embedder: fakeEmbedder(),
    });
    expect(again.suppressed).toBe(1);
    expect(again.clusters).toBe(0);
    expect(again.candidates).toHaveLength(0);
    expect(again.staged).toHaveLength(0);
    expect(await listStaged(org)).toHaveLength(0);
  });

  it("--include-rejected resurfaces a tombstoned candidate", async () => {
    await optedIn(acme, "Conventional commits", "use conventional commits on every repo", "acme");
    await optedIn(beta, "Conventional commits", "use conventional commits on every repo", "beta");

    await stageThenReject();

    const resurfaced = await graduateToOrgBrain({
      orgBrainDir: org,
      brainDirs: [acme, beta],
      embedder: fakeEmbedder(),
      includeRejected: true,
    });
    expect(resurfaced.suppressed).toBe(0);
    expect(resurfaced.clusters).toBe(1);
    expect(resurfaced.staged).toHaveLength(1);
  });

  it("a materially NEW cluster is unaffected by an unrelated tombstone", async () => {
    await optedIn(acme, "Conventional commits", "use conventional commits on every repo", "acme");
    await optedIn(beta, "Conventional commits", "use conventional commits on every repo", "beta");

    await stageThenReject();

    // A different cross-brain fact appears — its origin set (and thus key) differs, so it graduates.
    await optedIn(acme, "Deploy target", "we deploy on fly.io", "acme");
    await optedIn(beta, "Deploy target", "we deploy on fly.io", "beta");

    const mixed = await graduateToOrgBrain({
      orgBrainDir: org,
      brainDirs: [acme, beta],
      embedder: fakeEmbedder(),
    });
    expect(mixed.suppressed).toBe(1); // the rejected "conventional commits" cluster
    expect(mixed.clusters).toBe(1); // the new "deploy target" cluster
    expect(mixed.staged).toHaveLength(1);
    expect(mixed.candidates[0]!.title).toBe("Deploy target");
  });

  it("the tombstone round-trips through derived rebuild / verify-restore without complaint", async () => {
    await optedIn(acme, "Conventional commits", "use conventional commits on every repo", "acme");
    await optedIn(beta, "Conventional commits", "use conventional commits on every repo", "beta");

    await stageThenReject();
    const before = await loadTombstonedKeys(org);

    // The tombstone lives under .commonwealth/, which verifyBrain treats as a non-note dir: the
    // derived rebuild it performs must not flag it, and it must survive intact.
    await regenerateDerived(org);
    const result = await verifyBrain(org);
    expect(result.ok).toBe(true);
    for (const check of result.checks) {
      for (const offender of check.offenders ?? []) {
        expect(offender).not.toMatch(/graduation-tombstones/);
      }
    }

    // Still present and unchanged after the rebuild.
    expect(await loadTombstonedKeys(org)).toEqual(before);
    await expect(fs.stat(tombstonePath(org))).resolves.toBeTruthy();
  });
});
