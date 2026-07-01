import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initBrain, readNote, writeNote } from "@commons/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listWorkState, readNoteTool, remember, searchNotes, whoIs } from "../src/tools.js";

let brainDir: string;

beforeEach(async () => {
  brainDir = await fs.mkdtemp(path.join(tmpdir(), "commons-mcp-"));
  await initBrain(brainDir, { name: "test-brain" });
});

afterEach(async () => {
  await fs.rm(brainDir, { recursive: true, force: true });
});

describe("searchNotes", () => {
  it("finds a seeded note by a term and honors kind filter + limit", async () => {
    await writeNote(brainDir, {
      kind: "memory",
      title: "Auth uses OAuth device flow",
      body: "The pineapple service authenticates via the device flow.",
      tags: ["auth"],
    });
    await writeNote(brainDir, {
      kind: "decision",
      title: "Adopt pineapple as the mascot",
      body: "We chose pineapple for branding.",
    });

    const hits = await searchNotes(brainDir, { query: "pineapple" });
    expect(hits.length).toBe(2);
    expect(hits.map((h) => h.kind).sort()).toEqual(["decision", "memory"]);

    const memoryOnly = await searchNotes(brainDir, { query: "pineapple", kind: "memory" });
    expect(memoryOnly).toHaveLength(1);
    expect(memoryOnly[0]!.kind).toBe("memory");

    const capped = await searchNotes(brainDir, { query: "pineapple", limit: 1 });
    expect(capped).toHaveLength(1);
  });

  it("returns an empty array when nothing matches", async () => {
    const hits = await searchNotes(brainDir, { query: "nonexistentxyz" });
    expect(hits).toEqual([]);
  });
});

describe("readNoteTool", () => {
  it("returns a seeded note's frontmatter + body", async () => {
    const written = await writeNote(brainDir, {
      kind: "memory",
      title: "Billing quirk",
      body: "Invoices round half-up.",
      tags: ["billing"],
    });

    const result = await readNoteTool(brainDir, { path: written.path });
    expect(result.path).toBe(written.path);
    expect(result.frontmatter.title).toBe("Billing quirk");
    expect(result.frontmatter.kind).toBe("memory");
    expect(result.body).toBe("Invoices round half-up.");
  });

  it("throws on a missing path", async () => {
    await expect(readNoteTool(brainDir, { path: "memory/does-not-exist.md" })).rejects.toThrow();
  });
});

describe("remember", () => {
  it("persists a markdown note on disk that parses back", async () => {
    const { id, path: relPath } = await remember(brainDir, {
      kind: "memory",
      title: "Deploys happen on Fridays",
      body: "We ship at the end of the week.",
      tags: ["process"],
      author: "kristof",
    });

    expect(id).toMatch(/deploys/);
    const abs = path.join(brainDir, relPath);
    await expect(fs.access(abs)).resolves.toBeUndefined();

    const parsed = await readNote(brainDir, relPath);
    expect(parsed.frontmatter.id).toBe(id);
    expect(parsed.frontmatter.title).toBe("Deploys happen on Fridays");
    expect(parsed.frontmatter.author).toBe("kristof");
    expect(parsed.body).toBe("We ship at the end of the week.");
  });

  it("makes the new note findable via a subsequent search (index refresh)", async () => {
    // Prime the index so it already exists before the write — proves remember rebuilds it.
    expect(await searchNotes(brainDir, { query: "quokka" })).toEqual([]);

    await remember(brainDir, {
      kind: "memory",
      title: "The quokka protocol",
      body: "Named after the happiest animal.",
    });

    const hits = await searchNotes(brainDir, { query: "quokka" });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some((h) => h.title === "The quokka protocol")).toBe(true);
  });
});

describe("listWorkState", () => {
  it("returns active work-state and excludes done", async () => {
    await writeNote(brainDir, {
      kind: "work-state",
      title: "Ship the MCP server",
      body: "In flight.",
      fields: { status: "in-progress" },
    });
    await writeNote(brainDir, {
      kind: "work-state",
      title: "Set up the repo",
      body: "Complete.",
      fields: { status: "done" },
    });

    const active = await listWorkState(brainDir);
    expect(active).toHaveLength(1);
    expect(active[0]!.frontmatter.title).toBe("Ship the MCP server");
  });
});

describe("whoIs", () => {
  it("finds a seeded person note by name (case-insensitive)", async () => {
    await writeNote(brainDir, {
      kind: "person",
      title: "Ada Lovelace",
      body: "Works on the analytical engine.",
      fields: { name: "Ada Lovelace", role: "Engineer" },
    });
    await writeNote(brainDir, {
      kind: "person",
      title: "Grace Hopper",
      body: "Compiler pioneer.",
      fields: { name: "Grace Hopper" },
    });

    const hits = await whoIs(brainDir, { query: "ada" });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.frontmatter.kind).toBe("person");
    expect(hits[0]!.frontmatter.title).toBe("Ada Lovelace");
  });

  it("returns an empty array when no person matches", async () => {
    await writeNote(brainDir, {
      kind: "person",
      title: "Ada Lovelace",
      body: "x",
      fields: { name: "Ada Lovelace" },
    });
    expect(await whoIs(brainDir, { query: "zzz" })).toEqual([]);
  });
});
