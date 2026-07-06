import { describe, expect, it } from "vitest";
import { cosineSimilarity, embedProvider, loadHostedEmbedder } from "../src/embed.js";

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors and 0 for orthogonal ones", () => {
    const a = Float32Array.from([1, 0, 0]);
    expect(cosineSimilarity(a, Float32Array.from([1, 0, 0]))).toBeCloseTo(1, 6);
    expect(cosineSimilarity(a, Float32Array.from([0, 1, 0]))).toBeCloseTo(0, 6);
  });

  it("is scale-invariant (direction, not magnitude)", () => {
    expect(
      cosineSimilarity(Float32Array.from([1, 2, 3]), Float32Array.from([2, 4, 6])),
    ).toBeCloseTo(1, 6);
  });

  it("returns 0 for empty, length-mismatched, or zero-magnitude inputs", () => {
    expect(cosineSimilarity(new Float32Array(0), new Float32Array(0))).toBe(0);
    expect(cosineSimilarity(Float32Array.from([1, 2]), Float32Array.from([1, 2, 3]))).toBe(0);
    expect(cosineSimilarity(Float32Array.from([0, 0]), Float32Array.from([1, 1]))).toBe(0);
  });
});

describe("embedProvider", () => {
  it("returns null for the 'none' provider (no embedder loaded)", async () => {
    expect(await embedProvider({ provider: "none", threshold: 0.85 })).toBeNull();
  });

  it("throws an actionable error when the 'local' model package is not installed", async () => {
    // The local model package is intentionally NOT a dependency (ADR-0021), so importing it fails
    // in this repo — the error must tell the operator exactly how to fix it.
    await expect(embedProvider({ provider: "local", threshold: 0.85 })).rejects.toThrow(
      /@xenova\/transformers/,
    );
  });
});

describe("loadHostedEmbedder", () => {
  it("posts input to the endpoint and maps data[].embedding to vectors", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fakeFetch = async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }],
        }),
      };
    };
    const embedder = loadHostedEmbedder(
      { provider: "hosted", threshold: 0.85, endpoint: "https://api.example/embeddings" },
      fakeFetch,
    );

    const vecs = await embedder.embed(["one", "two"]);
    expect(vecs).toHaveLength(2);
    expect(Array.from(vecs[0]!)).toEqual([
      expect.closeTo(0.1, 5),
      expect.closeTo(0.2, 5),
      expect.closeTo(0.3, 5),
    ]);
    expect(calls[0]?.url).toBe("https://api.example/embeddings");
    expect(calls[0]?.body).toMatchObject({ input: ["one", "two"] });
  });

  it("throws when the endpoint is missing or the response is not ok", async () => {
    expect(() => loadHostedEmbedder({ provider: "hosted", threshold: 0.85 })).toThrow(
      /endpoint is not set/,
    );

    const failing = loadHostedEmbedder(
      { provider: "hosted", threshold: 0.85, endpoint: "https://api.example/embeddings" },
      async () => ({ ok: false, status: 500, statusText: "Server Error", json: async () => ({}) }),
    );
    await expect(failing.embed(["x"])).rejects.toThrow(/failed: 500/);
  });
});
