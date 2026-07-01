import { describe, expect, it } from "vitest";
import { formatContext } from "../src/context.js";
import type { Note } from "@commons/core";

function memoryNote(id: string, title: string, body: string): Note {
  return {
    frontmatter: {
      id,
      kind: "memory",
      title,
      created: "2026-07-01",
      status: "active",
      tags: [],
      schema_version: 1,
    } as Note["frontmatter"],
    body,
    path: `memory/${id}.md`,
  };
}

describe("formatContext", () => {
  it("returns an empty string for no notes", () => {
    expect(formatContext([])).toBe("");
  });

  it("renders titles, kinds and a snippet", () => {
    const out = formatContext([
      memoryNote("a", "Auth flow", "We use the OAuth device flow.\nSecond line ignored."),
      memoryNote("b", "Deploy trigger", "Deploys run on push to main."),
    ]);
    expect(out).toContain("## Relevant from the team brain");
    expect(out).toContain("- **Auth flow** (memory) — We use the OAuth device flow.");
    expect(out).toContain("- **Deploy trigger** (memory) — Deploys run on push to main.");
    // Only the first non-empty line becomes the snippet.
    expect(out).not.toContain("Second line ignored");
  });
});
