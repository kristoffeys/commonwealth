import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initBrain, setFeature, writeNote } from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeNeighbors } from "../src/neighbors.js";
import type { AnnotatedCandidate } from "../src/verdict.js";

/**
 * `neighbors` — the deterministic, offline first step of the LLM curation pass (ADR-0030). It ranks
 * each candidate's nearest CANON notes with the same similarity machinery the gate uses (lexical
 * Jaccard here — no embeddings provider in tests), and reports the `llmCurator` flag so the hook can
 * skip the classifier entirely when the feature is off.
 */

let brainDir: string;

const body = (s: string) => `${s} — a body comfortably past the fifteen character floor.`;

beforeEach(async () => {
  brainDir = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-neighbors-"));
  await initBrain(brainDir, { name: "neighbors-brain" });
});

afterEach(async () => {
  await fs.rm(brainDir, { recursive: true, force: true });
});

describe("computeNeighbors", () => {
  it("reports enabled:false and no neighbors when the llmCurator flag is off", async () => {
    await setFeature(brainDir, "llmCurator", false);
    await writeNote(brainDir, { kind: "memory", title: "JWT auth", body: body("we use JWT") });
    const cands: AnnotatedCandidate[] = [{ kind: "memory", title: "JWT", body: body("jwt again") }];
    const result = await computeNeighbors(brainDir, cands, { embedder: null });
    expect(result.enabled).toBe(false);
    expect(result.candidates[0]!.neighbors).toEqual([]);
  });

  it("ranks the nearest canon note first by lexical similarity (offline, no model)", async () => {
    await writeNote(brainDir, {
      id: "2026-07-01-jwt-a1",
      kind: "memory",
      title: "Auth uses JWT tokens",
      body: body("the service authenticates with JWT access tokens"),
    });
    await writeNote(brainDir, {
      id: "2026-07-01-cache-b2",
      kind: "memory",
      title: "Edge cache TTL",
      body: body("the edge cache holds responses for five minutes"),
    });
    const cands: AnnotatedCandidate[] = [
      {
        kind: "memory",
        title: "Auth JWT access tokens",
        body: body("we authenticate with JWT tokens"),
      },
    ];
    const result = await computeNeighbors(brainDir, cands, { k: 1, embedder: null });
    expect(result.enabled).toBe(true);
    const neighbors = result.candidates[0]!.neighbors;
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0]!.id).toBe("2026-07-01-jwt-a1");
    expect(neighbors[0]!.score).toBeGreaterThan(0);
    expect(neighbors[0]!.excerpt).toContain("JWT");
  });

  it("returns empty neighbors (still enabled) when canon is empty", async () => {
    const cands: AnnotatedCandidate[] = [
      { kind: "memory", title: "First", body: body("first fact") },
    ];
    const result = await computeNeighbors(brainDir, cands, { embedder: null });
    expect(result.enabled).toBe(true);
    expect(result.candidates[0]!.neighbors).toEqual([]);
  });
});
