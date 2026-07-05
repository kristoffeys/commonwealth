import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listNotes } from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approve, approveAll, reject } from "../src/review.js";
import { listStaged, stageNote } from "../src/staging.js";

let brainDir: string;

beforeEach(async () => {
  brainDir = await fs.mkdtemp(path.join(tmpdir(), "commonwealth-curate-review-"));
});

afterEach(async () => {
  await fs.rm(brainDir, { recursive: true, force: true });
});

describe("review", () => {
  it("approve moves a staged note into canon, preserving its id", async () => {
    const staged = await stageNote(brainDir, {
      kind: "memory",
      title: "A fact to approve",
      body: "This note should be promoted from staging into canon.",
    });
    const id = staged.frontmatter.id;

    const canonPath = await approve(brainDir, id);
    expect(canonPath).toBe(`memory/${id}.md`);

    const canon = await listNotes(brainDir);
    expect(canon.map((n) => n.frontmatter.id)).toContain(id);

    const pending = await listStaged(brainDir);
    expect(pending.map((n) => n.frontmatter.id)).not.toContain(id);
  });

  it("reject removes a staged note and it never reaches canon", async () => {
    const staged = await stageNote(brainDir, {
      kind: "memory",
      title: "A fact to reject",
      body: "This note should be discarded and never promoted.",
    });
    const id = staged.frontmatter.id;

    await reject(brainDir, id);

    const pending = await listStaged(brainDir);
    expect(pending.map((n) => n.frontmatter.id)).not.toContain(id);

    const canon = await listNotes(brainDir);
    expect(canon.map((n) => n.frontmatter.id)).not.toContain(id);
  });

  it("approve-all clears staging into canon", async () => {
    const a = await stageNote(brainDir, {
      kind: "memory",
      title: "First staged fact",
      body: "The first proposed note in the review queue.",
    });
    const b = await stageNote(brainDir, {
      kind: "decision",
      title: "Second staged decision",
      body: "The second proposed note in the review queue.",
    });

    const paths = await approveAll(brainDir);
    expect(paths).toHaveLength(2);

    const pending = await listStaged(brainDir);
    expect(pending).toHaveLength(0);

    const canonIds = (await listNotes(brainDir)).map((n) => n.frontmatter.id);
    expect(canonIds).toContain(a.frontmatter.id);
    expect(canonIds).toContain(b.frontmatter.id);
  });

  it("throws when approving an unknown id", async () => {
    await expect(approve(brainDir, "no-such-id")).rejects.toThrow(/no-such-id/);
  });

  it("a hand-crafted staged note with a traversal id cannot escape the brain on approve (#77)", async () => {
    // Simulate a poisoned staged file whose frontmatter id is a path-traversal payload.
    const evil = path.join(brainDir, "staging", "memory", "poison.md");
    await fs.mkdir(path.dirname(evil), { recursive: true });
    await fs.writeFile(
      evil,
      "---\nid: ../../../../tmp/pwned\nkind: memory\ntitle: Poison\ncreated: 2026-07-01\n---\nbody\n",
      "utf8",
    );
    // The id fails schema validation, so the note is rejected before any write escapes — it never
    // lands as an arbitrary file outside the brain.
    await expect(approve(brainDir, "../../../../tmp/pwned")).rejects.toThrow();
    await expect(fs.stat("/tmp/pwned.md")).rejects.toThrow();
  });
});

describe("review — project provenance (ADR-0015)", () => {
  it("approve promotes a sourced note into its <project>/<kind>/ subtree", async () => {
    const staged = await stageNote(brainDir, {
      kind: "memory",
      title: "Sourced fact",
      body: "A durable fact captured from a specific project.",
      source: "acme/widgets",
    });
    const id = staged.frontmatter.id;
    const canonPath = await approve(brainDir, id);
    expect(canonPath).toBe(`acme-widgets/memory/${id}.md`);
    const canon = await listNotes(brainDir);
    expect(canon.map((n) => n.frontmatter.source)).toContain("acme/widgets");
  });
});
