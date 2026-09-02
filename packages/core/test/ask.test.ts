import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  askBrain,
  buildIndex,
  initBrain,
  loadBrainConfig,
  saveBrainConfig,
  writeNote,
} from "../src/index.js";

/**
 * "Ask the brain" retrieval (ADR-0020, #108). Verifies citation-anchored, budget-bounded retrieval
 * and the coverage signal — the pieces that let an agent answer faithfully or decline. No synthesis
 * happens here (that's the agent's job); this only proves the retrieval contract.
 */
describe("askBrain", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cw-ask-"));
    await initBrain(dir, { name: "ask-brain" });
    await writeNote(dir, {
      kind: "decision",
      title: "Chose JWT over sessions for Acme",
      body: "We picked JWT bearer tokens over server sessions so the API stays stateless behind the load balancer.",
      fields: { deciders: ["ana"] },
    });
    await writeNote(dir, {
      kind: "memory",
      title: "Redis connection pool sizing",
      body: "The redis pool caps at 50 connections; beyond that we saw contention.",
    });
    await buildIndex(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns citation-anchored hits whose paths resolve to real notes", async () => {
    const result = await askBrain(dir, "jwt sessions stateless");
    expect(result.coverage.matched).toBe(true);
    expect(result.hits.length).toBeGreaterThan(0);
    const top = result.hits[0]!;
    expect(top.title).toContain("JWT");
    expect(top.id.length).toBeGreaterThan(0);
    // The cited path is real — the agent can `read` it; provenance can't be fabricated.
    expect(existsSync(path.join(dir, top.path))).toBe(true);
  });

  it("signals thin coverage instead of inventing an answer", async () => {
    const result = await askBrain(dir, "kubernetes helm chart rollout");
    expect(result.coverage.matched).toBe(false);
    expect(result.hits).toEqual([]);
    expect(result.coverage.topScore).toBe(0);
  });

  it("coverage.matched is true when only a semantic (paraphrase) hit exists (ADR-0025, #213)", async () => {
    // A note about Shopware; the question shares only the concept, so FTS5-AND finds nothing and
    // pre-hybrid ask would report matched:false. Hybrid (inherited from config) must flip that.
    await writeNote(dir, {
      kind: "memory",
      title: "Storefront platform",
      body: "The commerce site runs on Shopware after last year's migration.",
    });
    // Configure a hosted embeddings provider and stub fetch so the keyword→axis vectors are
    // deterministic: "shopware" → axis 0, everything else → the zero vector (no semantic match).
    const config = await loadBrainConfig(dir);
    config.embeddings = { provider: "hosted", threshold: 0.85, endpoint: "https://embed.test/v1" };
    await saveBrainConfig(dir, config);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      const { input } = JSON.parse(init.body) as { input: string[] };
      const axis = (t: string) =>
        t.toLowerCase().includes("shopware") ? [1, 0, 0, 0] : [0, 0, 0, 0];
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ data: input.map((t) => ({ embedding: axis(t) })) }),
      };
    }) as unknown as typeof fetch;
    try {
      await buildIndex(dir); // resolves the hosted provider → vectors populated
      const q = "did we ever use shopware before?";
      // FTS5 implicit-AND on this stopword-heavy query matches nothing; the OR fallback (#209) now
      // retrieves the note lexically, and the config-resolved hybrid path does too. Either way ask
      // reports coverage instead of a false "nothing matched" — the interplay stays coherent.
      const result = await askBrain(dir, q);
      expect(result.coverage.matched).toBe(true);
      expect(result.coverage.topScore).toBeGreaterThan(0);
      expect(result.hits[0]!.title).toBe("Storefront platform");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("attaches per-hit retrieval diagnostics only when asked (#236)", async () => {
    const plain = await askBrain(dir, "jwt sessions stateless");
    expect(plain.hits[0]!.diagnostics).toBeUndefined();
    expect(plain.coverage.prunedBelowThreshold).toBeUndefined();

    const diag = await askBrain(dir, "jwt sessions stateless", { diagnostics: true });
    const top = diag.hits[0]!;
    expect(top.diagnostics).toBeDefined();
    // Lexical FTS path (no embeddings configured here): a body match at lexical rank 1.
    expect(top.diagnostics!.lexicalRank).toBe(1);
    expect(top.diagnostics!.tier).toBe("lexical");
    // No gate exists on the lexical-only path, so the honest coverage value is null (#272 follow-up).
    expect(diag.coverage.prunedBelowThreshold).toBeNull();
  });

  it("coverage.prunedBelowThreshold reports the result-set kept/dropped count on the hybrid path (#272 follow-up)", async () => {
    // A semantic-only note with zero lexical/title/tag overlap on the query — pure vector noise,
    // pruned by a minLexicalSupport floor (same fixture shape as the core hybrid-search test).
    await writeNote(dir, {
      kind: "memory",
      title: "Scheduler internals",
      body: "pod scheduling internals for the cluster",
    });
    const config = await loadBrainConfig(dir);
    config.embeddings = { provider: "hosted", threshold: 0.85, endpoint: "https://embed.test/v1" };
    await saveBrainConfig(dir, config);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      const { input } = JSON.parse(init.body) as { input: string[] };
      const axis = (t: string) =>
        t.toLowerCase().includes("scheduling") || t.toLowerCase().includes("orchestration")
          ? [1, 0, 0, 0]
          : [0, 0, 0, 0];
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ data: input.map((t) => ({ embedding: axis(t) })) }),
      };
    }) as unknown as typeof fetch;
    try {
      await buildIndex(dir);
      const permissive = await askBrain(dir, "jwt orchestration", { diagnostics: true });
      expect(permissive.coverage.prunedBelowThreshold).toBe(0);

      const strict = await askBrain(dir, "jwt orchestration", {
        diagnostics: true,
        minLexicalSupport: 1,
      });
      expect(strict.coverage.prunedBelowThreshold).toBe(1);
      expect(strict.hits.map((h) => h.title)).not.toContain("Scheduler internals");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("honors the character budget, keeping the most relevant hits", async () => {
    for (let i = 0; i < 20; i++) {
      await writeNote(dir, {
        kind: "memory",
        title: `Widget fact ${i}`,
        body: `widget detail number ${i} ${"padding ".repeat(40)}`,
      });
    }
    await buildIndex(dir);
    const result = await askBrain(dir, "widget", { maxChars: 400 });
    expect(result.hits.length).toBeGreaterThan(0);
    const chars = result.hits.reduce(
      (n, h) => n + h.title.length + h.path.length + h.excerpt.length,
      0,
    );
    expect(chars).toBeLessThan(700); // budget honored (small overshoot for the last item)
  });
});
