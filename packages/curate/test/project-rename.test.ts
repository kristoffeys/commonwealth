import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initBrain,
  linkSources,
  listNotes,
  loadProjectAliasMap,
  persistProjectAliasMap,
  regenerateDerived,
  resolveNoteProject,
  writeNote,
  type NewNoteInput,
} from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renameProject } from "../src/rename.js";

/**
 * `project rename <old> <new>` (#304): rename a project id everywhere it is the identity (alias-map
 * key + declared `project` frontmatter) and move the folders to follow, in one commit. These
 * fixtures assert the load-bearing invariants — alias-only rename, declared-frontmatter rename, the
 * collision refusal (never a silent merge), invalid-id refusal, the write-nothing dry-run, and the
 * unknown-old refusal.
 */

let brain: string;

beforeEach(async () => {
  brain = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-rename-")));
  await initBrain(brain, { name: "rename-brain" });
});
afterEach(async () => {
  await fs.rm(brain, { recursive: true, force: true });
});

function git(...args: string[]): string {
  return execFileSync("git", ["-C", brain, ...args], { encoding: "utf8" });
}
function commitAll(msg: string): void {
  git("add", "-A");
  git("-c", "user.name=Test", "-c", "user.email=t@example.com", "commit", "-q", "-m", msg);
}
function head(): string {
  return git("rev-parse", "HEAD").trim();
}
function porcelain(): string {
  return git("status", "--porcelain").trim();
}

const mem = (title: string, source: string): NewNoteInput => ({
  kind: "memory",
  title,
  body: `Body for ${title}.`,
  source,
});

/** Content hash of every note file, to prove a dry-run wrote nothing. */
async function noteHashes(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const n of await listNotes(brain)) {
    const raw = await fs.readFile(path.join(brain, n.path), "utf8");
    out.set(n.path, createHash("sha256").update(raw).digest("hex"));
  }
  return out;
}

/** Resolve every note against the current alias map: id → resolved project. */
async function resolvedProjects(): Promise<Map<string, string | null>> {
  const map = await loadProjectAliasMap(brain);
  const out = new Map<string, string | null>();
  for (const n of await listNotes(brain)) {
    out.set(n.frontmatter.id, resolveNoteProject(n, map));
  }
  return out;
}

describe("renameProject — alias-only rename (identity via source link)", () => {
  it("renames the alias key, notes resolve to the new id, files move under <new>/", async () => {
    // Two repos of one engagement, linked by source alias — NO declared `project:` frontmatter.
    await writeNote(brain, mem("A", "weareantenna/acme-web"));
    await writeNote(brain, mem("B", "weareantenna/acme-api"));
    await persistProjectAliasMap(brain, (m) =>
      linkSources(m, "acme", ["weareantenna/acme-web", "weareantenna/acme-api"]),
    );
    await regenerateDerived(brain);
    commitAll("seed: acme link");

    const result = await renameProject(brain, "acme", "acme-corp");
    expect(result.skipped).toBeUndefined();
    expect(result.keyRenamed).toBe(true);
    expect(result.sources).toEqual(["weareantenna/acme-api", "weareantenna/acme-web"]);
    expect(result.restamped).toHaveLength(0); // nothing declared `project:` — pure alias rename
    expect(result.moves).toHaveLength(2);
    expect(result.committed).toBe(true);

    // The alias key was renamed, carrying its sources.
    const map = await loadProjectAliasMap(brain);
    expect(map).not.toHaveProperty("acme");
    expect(map["acme-corp"]!.sources).toEqual(["weareantenna/acme-api", "weareantenna/acme-web"]);

    // Every note now resolves to the new id and lives under its folder.
    for (const [, p] of await resolvedProjects()) expect(p).toBe("acme-corp");
    for (const n of await listNotes(brain)) {
      expect(n.path.startsWith("acme-corp/memory/")).toBe(true);
      // relayout stamps `project` onto moved notes (self-describing, ADR-0035).
      expect(n.frontmatter.project).toBe("acme-corp");
    }
    // One clean commit; nothing left dirty.
    expect(porcelain()).toBe("");
  });
});

describe("renameProject — declared-frontmatter rename", () => {
  it("rewrites project: <old> → <new> in frontmatter and moves the files", async () => {
    // Notes that DECLARE the project in their own frontmatter (save-time tier), no alias entry.
    await writeNote(brain, { ...mem("A", "acme/web"), project: "acme" });
    await writeNote(brain, { ...mem("B", "acme/api"), project: "acme" });
    await regenerateDerived(brain);
    commitAll("seed: declared acme notes");

    const result = await renameProject(brain, "acme", "acme-corp");
    expect(result.skipped).toBeUndefined();
    expect(result.keyRenamed).toBe(false); // no alias key existed
    expect(result.restamped).toHaveLength(2);
    expect(result.moves).toHaveLength(2);

    for (const n of await listNotes(brain)) {
      expect(n.frontmatter.project).toBe("acme-corp");
      expect(n.path.startsWith("acme-corp/memory/")).toBe(true);
    }
    // No stray alias entry was created.
    expect(await loadProjectAliasMap(brain)).toEqual({});
    expect(porcelain()).toBe("");
  });
});

describe("renameProject — refusals (never merge, never mass-write a bad id)", () => {
  it("refuses when <new> is already an alias-map key (would merge two projects)", async () => {
    await writeNote(brain, mem("A", "acme/web"));
    await writeNote(brain, mem("Z", "zed/repo"));
    await persistProjectAliasMap(brain, (m) => {
      linkSources(m, "acme", ["acme/web"]);
      linkSources(m, "zed", ["zed/repo"]);
    });
    await regenerateDerived(brain);
    commitAll("seed: two projects");

    const before = head();
    const mapBefore = await loadProjectAliasMap(brain);

    const result = await renameProject(brain, "acme", "zed");
    expect(result.skipped).toContain("already exists");
    expect(result.committed).toBe(false);
    // Nothing changed: alias map, HEAD, tree all intact.
    expect(await loadProjectAliasMap(brain)).toEqual(mapBefore);
    expect(head()).toBe(before);
    expect(porcelain()).toBe("");
  });

  it("refuses an invalid <new> id (path separator) and writes nothing", async () => {
    await writeNote(brain, mem("A", "acme/web"));
    await persistProjectAliasMap(brain, (m) => linkSources(m, "acme", ["acme/web"]));
    await regenerateDerived(brain);
    commitAll("seed");

    const before = head();
    const result = await renameProject(brain, "acme", "bad/id");
    expect(result.skipped).toContain("invalid project id");
    expect(result.committed).toBe(false);
    expect(await loadProjectAliasMap(brain)).toHaveProperty("acme");
    expect(head()).toBe(before);
    expect(porcelain()).toBe("");
  });

  it("refuses when <old> matches nothing (no key, no declared frontmatter, no resolving note)", async () => {
    await writeNote(brain, mem("A", "acme/web"));
    await regenerateDerived(brain);
    commitAll("seed");

    const before = head();
    const result = await renameProject(brain, "ghost", "phantom");
    expect(result.skipped).toContain('no project "ghost"');
    expect(head()).toBe(before);
    expect(porcelain()).toBe("");
  });
});

describe("renameProject — dry-run writes nothing", () => {
  it("prints the plan but leaves HEAD, files and projects.json untouched", async () => {
    await writeNote(brain, mem("A", "weareantenna/acme-web"));
    await writeNote(brain, mem("B", "weareantenna/acme-api"));
    await persistProjectAliasMap(brain, (m) =>
      linkSources(m, "acme", ["weareantenna/acme-web", "weareantenna/acme-api"]),
    );
    await regenerateDerived(brain);
    commitAll("seed");

    const before = head();
    const hashesBefore = await noteHashes();
    const mapBefore = await loadProjectAliasMap(brain);

    const result = await renameProject(brain, "acme", "acme-corp", { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.skipped).toBeUndefined();
    // The plan is computed against the projected post-rename world.
    expect(result.keyRenamed).toBe(true);
    expect(result.moves).toHaveLength(2);
    expect(result.moves.every((m) => m.to.startsWith("acme-corp/memory/"))).toBe(true);

    // Absolutely nothing was written.
    expect(await noteHashes()).toEqual(hashesBefore);
    expect(await loadProjectAliasMap(brain)).toEqual(mapBefore);
    expect(head()).toBe(before);
    expect(porcelain()).toBe("");
  });
});
