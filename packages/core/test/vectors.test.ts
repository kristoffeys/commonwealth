import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../src/embed.js";
import { saveBrainConfig, defaultBrainConfig } from "../src/config.js";
import { buildIndex, loadVectors, search } from "../src/index-db.js";
import { writeNote } from "../src/notes.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), "commonwealth-core-vectors-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Deterministic embedder: assigns each note a distinct unit vector by 1-based creation order. */
function sequentialEmbedder(dim = 4): Embedder {
  let n = 0;
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map(() => {
        const v = new Float32Array(dim);
        v[n % dim] = 1;
        n += 1;
        return v;
      });
    },
  };
}

describe("buildIndex vectors table (ADR-0021)", () => {
  it("populates a vectors table when given an embedder and round-trips via loadVectors", async () => {
    const a = await writeNote(dir, { kind: "memory", title: "One", body: "first durable fact" });
    const b = await writeNote(dir, { kind: "memory", title: "Two", body: "second durable fact" });

    const result = await buildIndex(dir, { embedder: sequentialEmbedder(4) });
    expect(result.indexed).toBe(2);
    expect(result.embedded).toBe(2);

    const vectors = await loadVectors(dir);
    expect(vectors.size).toBe(2);
    expect(vectors.has(a.frontmatter.id)).toBe(true);
    expect(vectors.has(b.frontmatter.id)).toBe(true);
    // Each vector round-trips with its exact dimension and float values.
    for (const vec of vectors.values()) {
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(4);
      // Sum of a unit basis vector is exactly 1 — proves the bytes survived the BLOB round-trip.
      expect(Array.from(vec).reduce((s, x) => s + x, 0)).toBeCloseTo(1, 6);
    }
  });

  it("leaves the vectors table empty when no embedder is used (default / flag off)", async () => {
    await writeNote(dir, { kind: "memory", title: "Solo", body: "a fact with no embedder" });

    // No opts → resolves from config; semanticDedup defaults off → vector-free build.
    const result = await buildIndex(dir);
    expect(result.indexed).toBe(1);
    expect(result.embedded).toBe(0);

    // Explicit null also forces a vector-free build; loadVectors returns an empty (not throwing) map.
    await buildIndex(dir, { embedder: null });
    expect((await loadVectors(dir)).size).toBe(0);
  });

  it("returns an empty map when no index has been built yet", async () => {
    expect((await loadVectors(dir)).size).toBe(0);
  });

  it("populates vectors when only semanticSearch is on (not just semanticDedup) (ADR-0025)", async () => {
    await writeNote(dir, { kind: "memory", title: "One", body: "a durable fact" });
    await writeNote(dir, { kind: "memory", title: "Two", body: "another durable fact" });

    // A resolvable-without-a-package provider: point at a "hosted" endpoint and stub global fetch,
    // so buildIndex's CONFIG-resolution branch (no explicit embedder) actually runs embedProvider.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      const { input } = JSON.parse(init.body) as { input: string[] };
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ data: input.map(() => ({ embedding: [1, 0, 0, 0] })) }),
      };
    }) as unknown as typeof fetch;
    try {
      // semanticDedup OFF, semanticSearch ON → the widened predicate must still want vectors.
      const config = defaultBrainConfig("test");
      config.features.semanticDedup = false;
      config.features.semanticSearch = true;
      config.embeddings = {
        provider: "hosted",
        threshold: 0.85,
        endpoint: "https://embed.test/v1",
      };
      await saveBrainConfig(dir, config);

      const result = await buildIndex(dir); // no explicit embedder → resolve from config
      expect(result.embedded).toBe(2);
      expect((await loadVectors(dir)).size).toBe(2);

      // Control: with BOTH flags off, the same provider is never resolved → vector-free build.
      config.features.semanticSearch = false;
      await saveBrainConfig(dir, config);
      expect((await buildIndex(dir)).embedded).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("is idempotent: rebuilding yields the same vectors, and lexical search still works", async () => {
    await writeNote(dir, {
      kind: "memory",
      title: "Deploy",
      body: "deployment runs on push to main",
    });

    await buildIndex(dir, { embedder: sequentialEmbedder(4) });
    const first = await loadVectors(dir);
    await buildIndex(dir, { embedder: sequentialEmbedder(4) });
    const second = await loadVectors(dir);

    expect([...second.keys()].sort()).toEqual([...first.keys()].sort());
    for (const [id, vec] of first) {
      expect(Array.from(second.get(id)!)).toEqual(Array.from(vec));
    }
    // The FTS table coexists with vectors — lexical search is unaffected.
    const hits = await search(dir, "deployment");
    expect(hits).toHaveLength(1);
  });
});
