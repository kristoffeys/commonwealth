import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildIndex, initBrain, setFeature, writeNote, type Embedder } from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkContradiction } from "../src/contradiction.js";

/**
 * `checkContradiction` — the embeddings invocation path the PreToolUse contradiction guard reuses
 * (ADR-0033). It embeds a compact change summary and nearest-neighbors it against the stored
 * `decision` vectors (cosine), surfacing the top hit at/above a conservative threshold. These tests
 * use a deterministic fake embedder so the WIRING is exercised without downloading a real model.
 */

let brainDir: string;

const body = (s: string) => `${s} — a body comfortably past the fifteen character floor.`;

beforeEach(async () => {
  brainDir = await fs.mkdtemp(path.join(tmpdir(), "commonwealth-contradiction-"));
  await initBrain(brainDir, { name: "contradiction-brain" });
});

afterEach(async () => {
  await fs.rm(brainDir, { recursive: true, force: true });
});

/**
 * Maps a "postgres" decision and a change summary that contradicts it ("switch to mysql") to
 * near-identical vectors (cosine ≈ 0.99), an unrelated decision to an orthogonal axis, and anything
 * else far away — so we can prove the guard surfaces the RIGHT decision and only above threshold.
 */
function conceptEmbedder(): Embedder {
  const DB = Float32Array.from([1, 0, 0]);
  const DB_NEAR = Float32Array.from([0.99, 0.1411, 0]); // cosine to DB ≈ 0.99
  const CACHE = Float32Array.from([0, 1, 0]);
  const OTHER = Float32Array.from([0, 0, 1]);
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((t) => {
        if (t.includes("PostgreSQL as the primary datastore")) return DB;
        if (t.includes("migrate the primary datastore to MySQL")) return DB_NEAR;
        if (t.includes("edge cache")) return CACHE;
        return OTHER;
      });
    },
  };
}

const DB_DECISION = {
  kind: "decision" as const,
  title: "Use PostgreSQL as the primary datastore",
  body: body("We standardize on PostgreSQL as the primary datastore for all services"),
};
const CONTRADICTING_CHANGE = "migrate the primary datastore to MySQL for the orders service";

describe("checkContradiction (ADR-0033)", () => {
  it("is a no-op when the contradictionGuard flag is off (default)", async () => {
    await writeNote(brainDir, DB_DECISION);
    await buildIndex(brainDir, { embedder: conceptEmbedder() });

    const result = await checkContradiction(brainDir, CONTRADICTING_CHANGE, {
      embedder: conceptEmbedder(),
    });

    expect(result.enabled).toBe(false);
    expect(result.match).toBeNull();
  });

  it("surfaces the decision a change contradicts when the flag is on and vectors are built", async () => {
    const decision = await writeNote(brainDir, DB_DECISION);
    await setFeature(brainDir, "contradictionGuard", true);
    await buildIndex(brainDir, { embedder: conceptEmbedder() });

    const result = await checkContradiction(brainDir, CONTRADICTING_CHANGE, {
      embedder: conceptEmbedder(),
    });

    expect(result.enabled).toBe(true);
    expect(result.provider).toBe(true);
    expect(result.match?.id).toBe(decision.frontmatter.id);
    expect(result.match?.title).toBe(DB_DECISION.title);
    expect(result.match?.path).toBe(decision.path);
    expect(result.match?.score).toBeGreaterThanOrEqual(0.82);
  });

  it("returns no match for an unrelated change below the threshold", async () => {
    await writeNote(brainDir, DB_DECISION);
    await setFeature(brainDir, "contradictionGuard", true);
    await buildIndex(brainDir, { embedder: conceptEmbedder() });

    // "edge cache" embeds orthogonally to the postgres decision → cosine 0 → nothing surfaced.
    const result = await checkContradiction(brainDir, "raise the edge cache TTL to ten minutes", {
      embedder: conceptEmbedder(),
    });

    expect(result.enabled).toBe(true);
    expect(result.match).toBeNull();
  });

  it("only compares against decision notes, never memory/work-state", async () => {
    // A MEMORY note whose text would embed near the change — but memories must never gate.
    await writeNote(brainDir, {
      kind: "memory",
      title: "Datastore note",
      body: body("We standardize on PostgreSQL as the primary datastore for all services"),
    });
    await setFeature(brainDir, "contradictionGuard", true);
    await buildIndex(brainDir, { embedder: conceptEmbedder() });

    const result = await checkContradiction(brainDir, CONTRADICTING_CHANGE, {
      embedder: conceptEmbedder(),
    });

    expect(result.enabled).toBe(true);
    expect(result.match).toBeNull();
  });

  it("ignores a superseded decision", async () => {
    const decision = await writeNote(brainDir, {
      ...DB_DECISION,
      fields: { status: "superseded", superseded_by: "some-newer-decision" },
    });
    await setFeature(brainDir, "contradictionGuard", true);
    await buildIndex(brainDir, { embedder: conceptEmbedder() });

    const result = await checkContradiction(brainDir, CONTRADICTING_CHANGE, {
      embedder: conceptEmbedder(),
    });

    expect(decision.frontmatter.status).toBe("superseded");
    expect(result.match).toBeNull();
  });

  it("reports provider:false (no match) when the flag is on but no vectors are built", async () => {
    await writeNote(brainDir, DB_DECISION);
    await setFeature(brainDir, "contradictionGuard", true);
    // Deliberately do NOT build vectors — the vectors table is empty.

    const result = await checkContradiction(brainDir, CONTRADICTING_CHANGE, {
      embedder: conceptEmbedder(),
    });

    expect(result.enabled).toBe(true);
    expect(result.match).toBeNull();
  });
});
