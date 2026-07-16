import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../src/embed.js";
import { buildIndex, search } from "../src/index-db.js";
import { writeNote } from "../src/notes.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), "commonwealth-hybrid-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/**
 * Deterministic keyword→axis embedder (ADR-0025 tests): each keyword maps to a fixed axis, and a
 * text's vector is the sum of the axes of the keywords it contains. So a query and a note that
 * share a keyword have non-zero cosine even when they share NO literal FTS token — mimicking a
 * paraphrase match. Unknown words contribute nothing.
 */
function keywordEmbedder(axes: Record<string, number>, dim = 8): Embedder {
  const vec = (text: string): Float32Array => {
    const v = new Float32Array(dim);
    const lower = text.toLowerCase();
    for (const [word, axis] of Object.entries(axes)) {
      if (lower.includes(word)) v[axis] = 1;
    }
    return v;
  };
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map(vec);
    },
  };
}

describe("hybrid semantic retrieval (ADR-0025, #213)", () => {
  it("retrieves a paraphrase-matched note when FTS5-AND returns zero (the #213 done-criterion)", async () => {
    // A note about Shopware; the query shares the "shopware" concept but is stopword-heavy so
    // FTS5's implicit-AND (did AND we AND use AND shopware AND before) finds nothing.
    await writeNote(dir, {
      kind: "memory",
      title: "Ecommerce platform",
      body: "The storefront was built on Shopware for the migration project.",
    });
    await writeNote(dir, {
      kind: "memory",
      title: "Unrelated",
      body: "Notes about the payroll spreadsheet and quarterly taxes.",
    });
    const embedder = keywordEmbedder({ shopware: 0, payroll: 1 });
    await buildIndex(dir, { embedder });

    // FTS5 implicit-AND finds nothing for the stopword query, but the OR fallback (#209) now
    // retrieves the Shopware note lexically too — so both the lexical-only and the hybrid paths
    // surface it. Coherent interplay: OR-fallback and semantic hits both feed the fused result.
    const lexical = await search(dir, "did we use shopware before?", { embedder: null });
    expect(lexical.map((h) => h.title)).toContain("Ecommerce platform");

    // Hybrid: the fused (lexical-OR ∪ semantic) result still matches the Shopware note.
    const hybrid = await search(dir, "did we use shopware before?", { embedder });
    expect(hybrid.map((h) => h.title)).toContain("Ecommerce platform");
    expect(hybrid[0]!.score).toBeGreaterThan(0);
  });

  it("is byte-identical to lexical when no embedder resolves (null / provider absent)", async () => {
    await writeNote(dir, { kind: "memory", title: "Auth", body: "JWT with refresh token" });
    await writeNote(dir, { kind: "memory", title: "Cache", body: "edge cache invalidation rules" });
    await buildIndex(dir, { embedder: keywordEmbedder({ jwt: 0, cache: 1 }) });

    // Default config path: semanticSearch flag is ON by default, but the default `local` provider
    // package is not installed → resolveSemantic returns null → lexical path.
    const viaConfig = await search(dir, "cache");
    // Explicit null forces lexical-only.
    const viaNull = await search(dir, "cache", { embedder: null });
    expect(viaConfig).toEqual(viaNull);
    expect(viaNull.map((r) => r.title)).toEqual(["Cache"]);
    // Lexical score is negated BM25 (positive), not RRF.
    expect(viaNull[0]!.score).toBeGreaterThan(0);
  });

  it("filters semantic hits by superseded, kind, and source like lexical hits", async () => {
    // Two shopware notes: one superseded, one canon; plus a decision-kind shopware note.
    await writeNote(dir, {
      kind: "memory",
      title: "Old shopware note",
      body: "shopware was the platform, since replaced",
      fields: { status: "superseded", superseded_by: "new-note" },
    });
    await writeNote(dir, {
      kind: "memory",
      title: "Current shopware note",
      body: "shopware is the platform",
      source: "storefront",
    });
    await writeNote(dir, {
      kind: "decision",
      title: "Shopware decision",
      body: "we will standardise on shopware",
      fields: { status: "accepted", deciders: [] },
    });
    const embedder = keywordEmbedder({ shopware: 0 });
    await buildIndex(dir, { embedder });

    // Stopword-heavy query: FTS5 implicit-AND matches nothing, but both the OR fallback (#209) and
    // the semantic side surface the shopware notes. The kind/source/superseded filters below apply
    // identically to the lexical and semantic candidates, so the expected titles hold for the
    // fused result no matter which list produced a given hit.
    const q = "was shopware ever evaluated for reuse";

    // Default: superseded note is excluded from semantic hits too.
    const canon = await search(dir, q, { embedder });
    const titles = canon.map((h) => h.title);
    expect(titles).toContain("Current shopware note");
    expect(titles).toContain("Shopware decision");
    expect(titles).not.toContain("Old shopware note");

    // kind filter applies to semantic candidates.
    const decisions = await search(dir, q, { embedder, kind: "decision" });
    expect(decisions.map((h) => h.title)).toEqual(["Shopware decision"]);

    // source filter applies to semantic candidates.
    const scoped = await search(dir, q, { embedder, source: "storefront" });
    expect(scoped.map((h) => h.title)).toEqual(["Current shopware note"]);

    // includeSuperseded resurfaces the archaeology.
    const withHistory = await search(dir, q, { embedder, includeSuperseded: true });
    expect(withHistory.map((h) => h.title)).toContain("Old shopware note");
  });

  it("falls back to lexical when the embedder throws — no rejection", async () => {
    await writeNote(dir, { kind: "memory", title: "Deploy", body: "deployment runs on push" });
    // Populate vectors with a working embedder so the vectors table is non-empty.
    await buildIndex(dir, { embedder: keywordEmbedder({ deployment: 0 }) });

    const throwing: Embedder = {
      async embed(): Promise<Float32Array[]> {
        throw new Error("boom");
      },
    };
    const hits = await search(dir, "deployment", { embedder: throwing });
    // Lexical still works; the query "deployment" matches the note's body token.
    expect(hits.map((h) => h.title)).toEqual(["Deploy"]);
  });

  it("falls back to lexical when the embedder hangs past the timeout — no latency cliff", async () => {
    await writeNote(dir, { kind: "memory", title: "Deploy", body: "deployment runs on push" });
    await buildIndex(dir, { embedder: keywordEmbedder({ deployment: 0 }) });

    const hanging: Embedder = {
      embed(): Promise<Float32Array[]> {
        return new Promise(() => {
          /* never resolves */
        });
      },
    };
    const start = Date.now();
    const hits = await search(dir, "deployment", { embedder: hanging, embedTimeoutMs: 50 });
    expect(Date.now() - start).toBeLessThan(2000);
    expect(hits.map((h) => h.title)).toEqual(["Deploy"]);
  });

  it("ranks a note matched by BOTH lists above single-list hits (RRF), stale still demoted", async () => {
    // Contains BOTH query tokens → a lexical (FTS-AND) hit, AND both semantic axes.
    await writeNote(dir, {
      kind: "memory",
      title: "Alpha both",
      body: "alpha and beta signal here",
    });
    // Only "beta" → fails FTS-AND on "alpha beta", so it is a semantic-only hit (axis 1).
    await writeNote(dir, {
      kind: "memory",
      title: "Beta semantic",
      body: "beta concept described",
    });
    // Matches both lists too, but stale → must sink below the fresh hits regardless of fusion score.
    await writeNote(dir, {
      kind: "memory",
      title: "Alpha stale",
      body: "alpha and beta but outdated",
      fields: { status: "stale" },
    });
    const embedder = keywordEmbedder({ alpha: 0, beta: 1 });
    await buildIndex(dir, { embedder });

    // Query has both literal tokens (lexical AND hit for the two-token notes) and both axes.
    const hits = await search(dir, "alpha beta", { embedder });
    const titles = hits.map((h) => h.title);
    // Fresh "Alpha both" (both lists) ranks first; stale "Alpha stale" is demoted to last.
    expect(titles[0]).toBe("Alpha both");
    expect(titles).toContain("Beta semantic");
    expect(titles[titles.length - 1]).toBe("Alpha stale");
  });

  it("feeds lexical-OR hits into the fusion when the semantic side misses (AND→OR→RRF, #209)", async () => {
    await writeNote(dir, {
      kind: "memory",
      title: "Migration",
      body: "we migrated the storefront to shopware last year",
    });
    // The embedder keys on an axis neither the note nor the query hits, so every vector is the
    // zero vector → cosine 0 → the semantic list is empty. Only the lexical-OR fallback can
    // surface the note, proving OR-fallback results join the fused list.
    const embedder = keywordEmbedder({ kubernetes: 0 });
    await buildIndex(dir, { embedder });

    const hits = await search(dir, "did we use shopware before", { embedder });
    expect(hits.map((h) => h.title)).toContain("Migration");
  });
});
