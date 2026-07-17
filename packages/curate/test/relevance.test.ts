import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeNote } from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { selectRelevant, selectRelevantDiagnostics } from "../src/relevance.js";

let brainDir: string;

beforeEach(async () => {
  brainDir = await fs.mkdtemp(path.join(tmpdir(), "commonwealth-curate-relevance-"));
});

afterEach(async () => {
  await fs.rm(brainDir, { recursive: true, force: true });
});

describe("selectRelevant", () => {
  it("returns the matching note for a query", async () => {
    const match = await writeNote(brainDir, {
      kind: "memory",
      title: "Kubernetes ingress quirk",
      body: "The kubernetes ingress controller drops websocket upgrades without an annotation.",
    });
    await writeNote(brainDir, {
      kind: "memory",
      title: "Billing rounds to cents",
      body: "The billing service rounds every line item to whole cents before summing.",
    });

    const results = await selectRelevant(brainDir, { query: "kubernetes ingress" });
    expect(results.map((n) => n.frontmatter.id)).toContain(match.frontmatter.id);
  });

  it("keeps a #213 OR-fallback paraphrase hit under the strict injection floor (#236)", async () => {
    // Injection is the first strict adopter (minLexicalSupport = 1). The right note has no query
    // keyword in its TITLE, but the #209 OR-fallback gives it lexical arrival (body says "shopware")
    // → support ≥ 1 → it still surfaces. This guards the #213 done-criterion for injected context.
    const match = await writeNote(brainDir, {
      kind: "memory",
      title: "Ecommerce platform",
      body: "The storefront was built on Shopware for the migration project.",
    });
    await writeNote(brainDir, {
      kind: "memory",
      title: "Payroll",
      body: "Notes about the payroll spreadsheet and quarterly taxes.",
    });

    const results = await selectRelevant(brainDir, { query: "did we use shopware before?" });
    expect(results.map((n) => n.frontmatter.id)).toContain(match.frontmatter.id);
  });

  it("selectRelevantDiagnostics attaches per-hit retrieval provenance (#236)", async () => {
    await writeNote(brainDir, {
      kind: "memory",
      title: "Kubernetes ingress quirk",
      body: "The kubernetes ingress controller drops websocket upgrades without an annotation.",
    });

    const hits = await selectRelevantDiagnostics(brainDir, "kubernetes ingress");
    expect(hits.length).toBeGreaterThan(0);
    const d = hits[0]!.result.diagnostics;
    expect(d).toBeDefined();
    expect(d!.lexicalRank).toBe(1);
    expect(["lexical", "hybrid", "semantic"]).toContain(d!.tier);
  });

  it("returns active work-state and excludes done", async () => {
    const active = await writeNote(brainDir, {
      kind: "work-state",
      title: "Ship the review queue",
      body: "Building the in-repo staging review queue for M3.",
      fields: { status: "in-progress" },
    });
    await writeNote(brainDir, {
      kind: "work-state",
      title: "Old finished task",
      body: "This work is complete and should not surface.",
      fields: { status: "done" },
    });

    const results = await selectRelevant(brainDir, {});
    const ids = results.map((n) => n.frontmatter.id);
    expect(ids).toContain(active.frontmatter.id);
    for (const n of results) {
      if (n.frontmatter.kind === "work-state") {
        expect(n.frontmatter.status).not.toBe("done");
      }
    }
  });
});
