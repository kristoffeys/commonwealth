import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initBrain, listNotes, readNote, writeNote } from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  askBrainTool,
  listWorkState,
  readNoteTool,
  remember,
  searchNotes,
  whoIs,
} from "../src/tools.js";

let brainDir: string;

beforeEach(async () => {
  vi.stubEnv("COMMONWEALTH_AUTHOR", "Test Contributor");
  vi.stubEnv("COMMONWEALTH_AUTHOR_EMAIL", "contributor@example.com");
  brainDir = await fs.mkdtemp(path.join(tmpdir(), "commonwealth-mcp-"));
  await initBrain(brainDir, { name: "test-brain" });
});

afterEach(async () => {
  await fs.rm(brainDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
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

describe("askBrainTool", () => {
  it("returns citation-anchored hits + coverage for a matching question", async () => {
    await writeNote(brainDir, {
      kind: "decision",
      title: "Chose pineapple over mango",
      body: "We picked pineapple because the mango supply chain was unreliable.",
    });
    const result = await askBrainTool(brainDir, { question: "pineapple mango supply" });
    expect(result.coverage.matched).toBe(true);
    expect(result.hits[0]!.title).toContain("pineapple");
    expect(result.hits[0]!.path.length).toBeGreaterThan(0); // a real citation handle
  });

  it("signals thin coverage rather than fabricating", async () => {
    const result = await askBrainTool(brainDir, { question: "nonexistentxyz topic" });
    expect(result.coverage.matched).toBe(false);
    expect(result.hits).toEqual([]);
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
  it("promotes to canon (autoPromote on) a note that parses back on disk", async () => {
    const result = await remember(brainDir, {
      kind: "memory",
      title: "Deploys happen on Fridays",
      body: "We ship at the end of the week.",
      tags: ["process"],
    });

    expect(result.status).toBe("promoted");
    expect(result.id).toMatch(/deploys/);
    const abs = path.join(brainDir, result.path!);
    await expect(fs.access(abs)).resolves.toBeUndefined();

    const parsed = await readNote(brainDir, result.path!);
    expect(parsed.frontmatter.id).toBe(result.id);
    expect(parsed.frontmatter.title).toBe("Deploys happen on Fridays");
    expect(parsed.frontmatter.author).toBe("Test Contributor");
    expect(result.personId).toBeTruthy();
    expect(parsed.frontmatter.author_ref).toBe(result.personId);
    expect(parsed.frontmatter.relates).toContain(result.personId);
    const people = await listNotes(brainDir, "person");
    expect(people).toHaveLength(1);
    expect(people[0]!.frontmatter).toMatchObject({
      kind: "person",
      name: "Test Contributor",
    });
    expect(parsed.body).toBe("We ship at the end of the week.");
  });

  it("rejects a note carrying a secret — no longer writes straight to canon (#82)", async () => {
    const result = await remember(brainDir, {
      kind: "memory",
      title: "Deploy creds",
      body: "Authenticate with AKIAIOSFODNN7EXAMPLE against the bucket.",
    });
    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("contains-secret");
    // Rejected writes create neither the memory nor a contributor person in canon.
    expect(await searchNotes(brainDir, { query: "creds" })).toEqual([]);
    expect(await listNotes(brainDir, "person")).toHaveLength(0);
  });

  it("stages for review instead of canon when autoPromote is off (#82)", async () => {
    const { setFeature } = await import("@cmnwlth/core");
    await setFeature(brainDir, "autoPromote", false);
    const result = await remember(brainDir, {
      kind: "memory",
      title: "Held for review",
      body: "This should wait in the staging queue for manual approval.",
    });
    expect(result.status).toBe("staged");
    // Staged notes are not in canon / not searchable until approved.
    expect(await searchNotes(brainDir, { query: "review" })).toEqual([]);
  });

  it("rejects a near-duplicate of an existing note (#82 dedup gate)", async () => {
    const body = "The edge cache holds responses for exactly five minutes before revalidating.";
    expect((await remember(brainDir, { kind: "memory", title: "Cache TTL", body })).status).toBe(
      "promoted",
    );
    const dup = await remember(brainDir, { kind: "memory", title: "Cache TTL", body });
    expect(dup.status).toBe("rejected");
    expect(dup.reason).toBe("duplicate");
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
