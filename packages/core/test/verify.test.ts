import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initBrain, regenerateDerived, verifyBrain, writeNote } from "../src/index.js";

/**
 * `verifyBrain` — the disaster-recovery proof (#136). Builds a real valid brain, proves it
 * verifies, then breaks one invariant per test and confirms the matching check catches it.
 */
describe("verifyBrain", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cw-verify-core-"));
    await initBrain(dir, { name: "test-brain" });
    await writeNote(dir, { kind: "memory", title: "Alpha", body: "the alpha fact" });
    await writeNote(dir, {
      kind: "decision",
      title: "Beta",
      body: "the beta decision",
      fields: { deciders: [] },
    });
    await regenerateDerived(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const check = (r: Awaited<ReturnType<typeof verifyBrain>>, id: string) =>
    r.checks.find((c) => c.id === id)!;

  it("verifies a healthy brain — every check passes", async () => {
    const r = await verifyBrain(dir);
    expect(r.ok).toBe(true);
    expect(r.noteCount).toBe(2);
    for (const c of r.checks) expect(c.ok).toBe(true);
  });

  it("fails the schema check on a malformed note", async () => {
    await fs.writeFile(path.join(dir, "memory", "broken.md"), "---\nnot: a note\n---\ngarbage\n");
    const r = await verifyBrain(dir);
    expect(check(r, "schema").ok).toBe(false);
    expect(check(r, "schema").offenders?.[0]).toContain("broken.md");
    expect(r.ok).toBe(false);
  });

  it("fails the unique-ids check on a duplicated id", async () => {
    // Copy an existing note under a new filename → same id, two files.
    const entries = await fs.readdir(path.join(dir, "memory"));
    const note = entries.find((e) => e.endsWith(".md") && e !== "INDEX.md")!;
    await fs.copyFile(path.join(dir, "memory", note), path.join(dir, "memory", "copy.md"));
    await regenerateDerived(dir); // keep derived current so ONLY the ids check fails
    const r = await verifyBrain(dir);
    expect(check(r, "ids").ok).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("fails the supersede check on a dangling reference", async () => {
    await writeNote(dir, {
      kind: "memory",
      title: "Orphan pointer",
      body: "points nowhere",
      fields: { superseded_by: "does-not-exist" },
    });
    await regenerateDerived(dir);
    const r = await verifyBrain(dir);
    expect(check(r, "supersede").ok).toBe(false);
    expect(check(r, "supersede").offenders?.some((o) => o.includes("does-not-exist"))).toBe(true);
  });

  it("fails the secrets check when canon contains a credential", async () => {
    await writeNote(dir, {
      kind: "memory",
      title: "Leaky note",
      body: "prod key AKIAIOSFODNN7EXAMPLE do not commit",
    });
    await regenerateDerived(dir);
    const r = await verifyBrain(dir);
    expect(check(r, "secrets").ok).toBe(false);
    expect(check(r, "secrets").offenders?.[0]).toContain("aws-access-key-id");
  });

  it("fails the derived check when COMMONWEALTH.md drifts from the notes", async () => {
    const md = path.join(dir, "COMMONWEALTH.md");
    await fs.writeFile(md, (await fs.readFile(md, "utf8")) + "\nstale hand edit\n");
    const r = await verifyBrain(dir);
    expect(check(r, "derived").ok).toBe(false);
    expect(check(r, "derived").offenders).toContain("COMMONWEALTH.md");
  });
});

/**
 * Regression: a brain must be able to hold a hand-written README. READMEs used to satisfy the
 * structural derived-file predicate, so `verifyBrain` regenerated the derived layer, failed to
 * reproduce the README, and reported it as drift forever — failing the generated CI gate on every
 * push (and `regenerateDerived`'s prune deleted it).
 */
describe("verifyBrain with hand-written READMEs", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cw-verify-readme-"));
    await initBrain(dir, { name: "readme-brain" });
    await writeNote(dir, { kind: "memory", title: "Alpha", body: "the alpha fact" });
    await regenerateDerived(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("passes the derived check with edited READMEs at the root and nested", async () => {
    await fs.writeFile(path.join(dir, "README.md"), "# Our brain\n\nHand-edited.\n", "utf8");
    await fs.mkdir(path.join(dir, "docs"), { recursive: true });
    await fs.writeFile(path.join(dir, "docs", "README.md"), "# Docs\n\nBy hand.\n", "utf8");
    await fs.mkdir(path.join(dir, ".github"), { recursive: true });
    await fs.writeFile(path.join(dir, ".github", "README.md"), "# CI notes\n", "utf8");

    const r = await verifyBrain(dir);
    const derived = r.checks.find((c) => c.id === "derived")!;
    expect(derived.offenders ?? []).toEqual([]);
    expect(derived.ok).toBe(true);
    expect(r.ok).toBe(true);
  });

  it("regenerateDerived does not prune or rewrite a hand-written README", async () => {
    const body = "# Our brain\n\nStill here after a regenerate.\n";
    await fs.writeFile(path.join(dir, "README.md"), body, "utf8");
    await regenerateDerived(dir);
    expect(await fs.readFile(path.join(dir, "README.md"), "utf8")).toBe(body);
  });
});
