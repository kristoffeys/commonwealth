import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  linkSources,
  loadProjectAliasMap,
  persistProjectAliasMap,
  projectForSource,
  projectsMapPath,
  resolveNoteProject,
  unlinkSources,
  type ProjectAliasMap,
} from "../src/projects";
import type { Note } from "../src/schema";

let brain: string;

beforeEach(async () => {
  brain = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-projects-")));
});
afterEach(async () => {
  await fs.rm(brain, { recursive: true, force: true });
});

async function writeMap(contents: unknown): Promise<void> {
  const file = projectsMapPath(brain);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    typeof contents === "string" ? contents : JSON.stringify(contents),
    "utf8",
  );
}

/** Minimal note with a given source/project frontmatter, for resolver tests. */
function note(fm: { source?: string; project?: string }): Note {
  return {
    frontmatter: {
      kind: "memory",
      id: "x",
      title: "t",
      tags: [],
      created: "2026-07-16",
      status: "active",
      sources: [],
      relates: [],
      ...fm,
    } as Note["frontmatter"],
    body: "",
    path: "memory/x.md",
  };
}

describe("loadProjectAliasMap", () => {
  it("returns {} when the file is absent", async () => {
    expect(await loadProjectAliasMap(brain)).toEqual({});
  });

  it("loads a valid map, dropping malformed entries", async () => {
    await writeMap({
      "acme-eng": { customer: "Acme", sources: ["weareantenna/acme-website", "Acme Website"] },
      broken: 42,
      "empty-sources": { sources: "not-an-array" },
    });
    const map = await loadProjectAliasMap(brain);
    expect(map["acme-eng"]).toEqual({
      customer: "Acme",
      sources: ["weareantenna/acme-website", "Acme Website"],
    });
    expect(map).not.toHaveProperty("broken");
    expect(map["empty-sources"]).toEqual({ sources: [] });
  });

  it("treats a corrupt map as empty for reads AND emits one breadcrumb per file", async () => {
    await writeMap("{ not json");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await loadProjectAliasMap(brain)).toEqual({});
      // Second read of the same corrupt file: still empty, but no second breadcrumb.
      expect(await loadProjectAliasMap(brain)).toEqual({});
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toContain("corrupt");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("persistProjectAliasMap", () => {
  it("writes deterministic, sorted JSON", async () => {
    await persistProjectAliasMap(brain, (m) => {
      linkSources(m, "b-proj", ["z-src", "a-src"]);
      linkSources(m, "a-proj", ["m-src"]);
    });
    const raw = await fs.readFile(projectsMapPath(brain), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(raw) as ProjectAliasMap;
    expect(Object.keys(parsed)).toEqual(["a-proj", "b-proj"]);
    expect(parsed["b-proj"]!.sources).toEqual(["a-src", "z-src"]);
  });

  it("refuses to overwrite a corrupt map: backs it up and throws", async () => {
    await writeMap("}} corrupt {{");
    await expect(persistProjectAliasMap(brain, (m) => linkSources(m, "p", ["s"]))).rejects.toThrow(
      /Refusing to overwrite a corrupt project alias map/,
    );
    // The original corrupt file was backed up, not clobbered.
    const files = await fs.readdir(path.dirname(projectsMapPath(brain)));
    expect(files.some((f) => f.startsWith("projects.json.corrupt-"))).toBe(true);
  });

  it("round-trips link then unlink; removing the last source deletes the entry", async () => {
    await persistProjectAliasMap(brain, (m) => linkSources(m, "eng", ["src-a", "src-b"]));
    await persistProjectAliasMap(brain, (m) => unlinkSources(m, "eng", ["src-a"]));
    expect((await loadProjectAliasMap(brain))["eng"]).toEqual({ sources: ["src-b"] });
    await persistProjectAliasMap(brain, (m) => unlinkSources(m, "eng", ["src-b"]));
    expect(await loadProjectAliasMap(brain)).toEqual({});
  });
});

describe("resolveNoteProject", () => {
  const aliasMap: ProjectAliasMap = {
    "acme-eng": { sources: ["weareantenna/acme-website", "Acme Website"] },
  };

  it("tier 1: the note's own frontmatter project wins", () => {
    expect(resolveNoteProject(note({ project: "declared", source: "some/src" }), aliasMap)).toBe(
      "declared",
    );
  });

  it("tier 1: frontmatter project wins even when the alias map disagrees (no read-time warning)", () => {
    const n = note({ project: "declared", source: "weareantenna/acme-website" });
    expect(resolveNoteProject(n, aliasMap)).toBe("declared");
  });

  it("tier 2: an alias-map entry whose sources contain the note's source", () => {
    expect(resolveNoteProject(note({ source: "Acme Website" }), aliasMap)).toBe("acme-eng");
    expect(resolveNoteProject(note({ source: "weareantenna/acme-website" }), aliasMap)).toBe(
      "acme-eng",
    );
  });

  it("tier 3: the source itself when nothing links it (singleton project)", () => {
    expect(resolveNoteProject(note({ source: "solo/repo" }), aliasMap)).toBe("solo/repo");
  });

  it("returns null for an unattributed note (no project, no source)", () => {
    expect(resolveNoteProject(note({}), aliasMap)).toBeNull();
  });
});

describe("projectForSource", () => {
  it("finds the linking project or null", () => {
    const map: ProjectAliasMap = { eng: { sources: ["a", "b"] } };
    expect(projectForSource("a", map)).toBe("eng");
    expect(projectForSource("z", map)).toBeNull();
  });
});
