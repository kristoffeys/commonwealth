import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initBrain,
  isDerivedMarkdownFile,
  linkSources,
  listNotes,
  loadProjectAliasMap,
  persistProjectAliasMap,
  writeNote,
  type NewNoteInput,
} from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { relayoutBrain } from "../src/relayout.js";

/**
 * `project relayout` (ADR-0035): MOVE canon note files so the physical tree keys off the resolved
 * project, not the raw source. These fixtures assert the load-bearing invariants — files physically
 * move under `<project>/<kind>/`, zero notes are lost, `project` is stamped, a second run is a no-op,
 * `--dry-run` writes nothing, one MOC per project folder, and destination collisions fail closed.
 */

let brain: string;

beforeEach(async () => {
  brain = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-relayout-")));
  await initBrain(brain, { name: "relayout-brain" });
});
afterEach(async () => {
  await fs.rm(brain, { recursive: true, force: true });
});

const mem = (title: string, source: string): NewNoteInput => ({
  kind: "memory",
  title,
  body: `Body for ${title}.`,
  source,
});

/** Every note's repo-relative path, sorted. */
async function notePaths(): Promise<string[]> {
  return (await listNotes(brain)).map((n) => n.path).sort();
}

/** Repo-relative paths of every tracked derived MOC (not COMMONWEALTH.md), sorted. */
async function mocPaths(): Promise<string[]> {
  const out: string[] = [];
  async function walk(abs: string): Promise<void> {
    for (const e of await fs.readdir(abs, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if ([".git", ".commonwealth", "index", "staging", "node_modules"].includes(e.name)) continue;
        await walk(path.join(abs, e.name));
        continue;
      }
      const rel = path.relative(brain, path.join(abs, e.name)).split(path.sep).join("/");
      if (rel !== "COMMONWEALTH.md" && isDerivedMarkdownFile(rel)) out.push(rel);
    }
  }
  await walk(brain);
  return out.sort();
}

describe("relayoutBrain", () => {
  it("moves notes from ≥2 linked sources under one project folder, stamps project, loses nothing", async () => {
    // Two repos of one engagement + an unrelated singleton source.
    await writeNote(brain, mem("A", "weareantenna/acme-web"));
    await writeNote(brain, mem("B", "weareantenna/acme-api"));
    await writeNote(brain, mem("Solo", "other/thing"));
    await persistProjectAliasMap(brain, (m) =>
      linkSources(m, "acme", ["weareantenna/acme-web", "weareantenna/acme-api"]),
    );

    const before = await notePaths();
    expect(before).toHaveLength(3);

    const result = await relayoutBrain(brain);
    expect(result.dryRun).toBe(false);
    // The two linked-repo notes move; the singleton stays put.
    expect(result.moves).toHaveLength(2);
    expect(result.moves.every((m) => m.to.startsWith("acme/memory/"))).toBe(true);

    const after = await listNotes(brain);
    // (b) zero loss — count invariant.
    expect(after).toHaveLength(3);
    // (a) the two engagement notes physically live under acme/memory/ now.
    const acme = after.filter((n) => n.path.startsWith("acme/memory/"));
    expect(acme).toHaveLength(2);
    // (c) project stamped onto each moved note; provenance preserved.
    for (const n of acme) {
      expect(n.frontmatter.project).toBe("acme");
      expect(n.frontmatter.source).toMatch(/^weareantenna\/acme-(web|api)$/);
    }
    // The singleton is untouched (no project stamp, still under its source folder).
    const solo = after.find((n) => n.frontmatter.title === "Solo")!;
    expect(solo.path).toBe(`other-thing/memory/${solo.frontmatter.id}.md`);
    expect(solo.frontmatter).not.toHaveProperty("project");
    // Old source folders were swept away.
    expect(existsSync(path.join(brain, "weareantenna-acme-web"))).toBe(false);
    expect(existsSync(path.join(brain, "weareantenna-acme-api"))).toBe(false);
  });

  it("is idempotent — a second run moves nothing", async () => {
    await writeNote(brain, mem("A", "acme-web"));
    await writeNote(brain, mem("B", "acme-api"));
    await persistProjectAliasMap(brain, (m) => linkSources(m, "acme", ["acme-web", "acme-api"]));

    const first = await relayoutBrain(brain);
    expect(first.moves.length).toBeGreaterThan(0);
    const afterFirst = await notePaths();

    const second = await relayoutBrain(brain);
    expect(second.moves).toHaveLength(0);
    expect(await notePaths()).toEqual(afterFirst);
  });

  it("--dry-run reports moves but writes nothing", async () => {
    await writeNote(brain, mem("A", "acme-web"));
    await writeNote(brain, mem("B", "acme-api"));
    await persistProjectAliasMap(brain, (m) => linkSources(m, "acme", ["acme-web", "acme-api"]));

    const before = await notePaths();
    const dry = await relayoutBrain(brain, { dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.moves).toHaveLength(2);
    // Nothing on disk changed.
    expect(await notePaths()).toEqual(before);
    // No note gained a project stamp.
    for (const n of await listNotes(brain)) expect(n.frontmatter).not.toHaveProperty("project");
  });

  it("emits exactly one MOC per project folder after relayout", async () => {
    await writeNote(brain, mem("A", "acme-web"));
    await writeNote(brain, mem("B", "acme-api"));
    await writeNote(brain, mem("Solo", "other-thing"));
    await persistProjectAliasMap(brain, (m) => linkSources(m, "acme", ["acme-web", "acme-api"]));

    await relayoutBrain(brain);

    const mocs = await mocPaths();
    // One MOC under acme/ (the consolidated engagement) + one under the singleton's folder.
    expect(mocs).toHaveLength(2);
    const acmeMocs = mocs.filter((p) => p.startsWith("acme/"));
    expect(acmeMocs).toHaveLength(1);
    expect(mocs.some((p) => p.startsWith("other-thing/"))).toBe(true);
  });

  it("filters to a single project when a projectId is given", async () => {
    await writeNote(brain, mem("A", "acme-web"));
    await writeNote(brain, mem("Z", "zed-repo"));
    await persistProjectAliasMap(brain, (m) => {
      linkSources(m, "acme", ["acme-web"]);
      linkSources(m, "zed", ["zed-repo"]);
    });

    const result = await relayoutBrain(brain, { projectId: "acme" });
    expect(result.moves).toHaveLength(1);
    expect(result.moves[0]!.to.startsWith("acme/memory/")).toBe(true);

    const after = await listNotes(brain);
    const z = after.find((n) => n.frontmatter.title === "Z")!;
    // Zed was out of the filter — left exactly where it was.
    expect(z.path).toBe(`zed-repo/memory/${z.frontmatter.id}.md`);
    expect(z.frontmatter).not.toHaveProperty("project");
  });

  it("fails closed (no overwrite) when a destination already exists", async () => {
    // Two notes with the SAME trusted id under different sources both resolve to project "p" and would
    // collide on the same destination path — the pass must abort before moving anything.
    await writeNote(brain, { id: "dup-note", kind: "memory", title: "One", body: "b", source: "s-one" });
    await writeNote(brain, { id: "dup-note", kind: "memory", title: "Two", body: "b", source: "s-two" });
    await persistProjectAliasMap(brain, (m) => linkSources(m, "p", ["s-one", "s-two"]));

    const before = await notePaths();
    await expect(relayoutBrain(brain)).rejects.toThrow(/id collision|overwrite/i);
    // Nothing moved — the brain is untouched.
    expect(await notePaths()).toEqual(before);
    // The alias map is still intact and readable.
    expect(await loadProjectAliasMap(brain)).toHaveProperty("p");
  });
});
