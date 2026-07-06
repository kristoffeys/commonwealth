import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildIndex, setFeature, writeNote, type Embedder } from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { curate } from "../src/curate.js";

let brainDir: string;

beforeEach(async () => {
  brainDir = await fs.mkdtemp(path.join(tmpdir(), "commonwealth-curate-semantic-"));
});

afterEach(async () => {
  await fs.rm(brainDir, { recursive: true, force: true });
});

// A canon note and a paraphrase of it that share almost no surface tokens, so the lexical
// (Jaccard) gate does NOT treat them as duplicates — the whole point semantic dedup addresses.
const CANON = {
  kind: "memory" as const,
  title: "Auth uses OAuth device flow",
  body: "The service authenticates clients with the OAuth 2.0 device authorization flow.",
};
const PARAPHRASE = {
  kind: "memory" as const,
  title: "Bearer-token sign-in",
  body: "We log users in by issuing signed bearer credentials at the gateway.",
};

/**
 * A deterministic stand-in for a real embedding model: it maps the two lexically-distinct texts
 * above to near-identical vectors (cosine ≈ 0.99) and anything else to an orthogonal axis. This
 * lets us prove the WIRING catches a paraphrase the lexical gate misses, without downloading a
 * ~100MB model in CI.
 */
function conceptEmbedder(): Embedder {
  const AUTH = Float32Array.from([1, 0, 0]);
  const AUTH_NEAR = Float32Array.from([0.99, 0.1411, 0]); // cosine to AUTH ≈ 0.99
  const OTHER = Float32Array.from([0, 0, 1]);
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((t) => {
        if (t.includes("OAuth 2.0 device")) return AUTH;
        if (t.includes("signed bearer credentials")) return AUTH_NEAR;
        return OTHER;
      });
    },
  };
}

describe("semantic dedup gate (ADR-0021)", () => {
  it("with the flag OFF, a paraphrase the lexical gate misses is still staged (unchanged behavior)", async () => {
    await writeNote(brainDir, CANON);

    // Flag off (default): no embedder is resolved even if we pass one — the gate never consults it.
    const result = await curate(brainDir, [PARAPHRASE], undefined, conceptEmbedder());

    expect(result.rejected).toHaveLength(0);
    expect(result.staged).toHaveLength(1);
    expect(result.staged[0]?.frontmatter.title).toBe(PARAPHRASE.title);
  });

  it("with the flag ON and canon vectors built, rejects the paraphrase as a duplicate", async () => {
    const canon = await writeNote(brainDir, CANON);
    await setFeature(brainDir, "semanticDedup", true);
    // Build the index WITH the embedder so the canon note's vector lands in the vectors table.
    await buildIndex(brainDir, { embedder: conceptEmbedder() });

    const result = await curate(brainDir, [PARAPHRASE], undefined, conceptEmbedder());

    expect(result.staged).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toBe("duplicate");
    expect(result.rejected[0]?.duplicateOf).toBe(canon.frontmatter.id);
  });

  it("with the flag ON but no canon vectors yet, does not falsely reject (no-op fallback)", async () => {
    await writeNote(brainDir, CANON);
    await setFeature(brainDir, "semanticDedup", true);
    // Deliberately do NOT build vectors (no embedder-backed buildIndex) — the vectors table is empty.

    const result = await curate(brainDir, [PARAPHRASE], undefined, conceptEmbedder());

    // No canon vectors to compare against → semantic gate no-ops, lexical accepts the paraphrase.
    expect(result.rejected).toHaveLength(0);
    expect(result.staged).toHaveLength(1);
  });

  it("with the flag ON, a semantically-unrelated novel note still stages", async () => {
    await writeNote(brainDir, CANON);
    await setFeature(brainDir, "semanticDedup", true);
    await buildIndex(brainDir, { embedder: conceptEmbedder() });

    const novel = {
      kind: "memory" as const,
      title: "CI cache location",
      body: "Continuous integration caches node_modules under the runner tmp directory.",
    };
    const result = await curate(brainDir, [novel], undefined, conceptEmbedder());

    expect(result.rejected).toHaveLength(0);
    expect(result.staged).toHaveLength(1);
  });
});
