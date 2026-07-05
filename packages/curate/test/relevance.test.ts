import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeNote } from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { selectRelevant } from "../src/relevance.js";

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
