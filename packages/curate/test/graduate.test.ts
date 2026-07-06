import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initBrain, listNotes, setFeature, writeNote, type Embedder } from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { graduateToOrgBrain } from "../src/graduate.js";
import { listStaged } from "../src/staging.js";

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
