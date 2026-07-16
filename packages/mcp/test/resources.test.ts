import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initBrain, regenerateDerived, writeNote } from "@cmnwlth/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listBrainResources, moreResourceUri, RESOURCE_LIST_CAP } from "../src/resources.js";
import { createServer } from "../src/server.js";

const BRAIN = "test-brain";
let brainDir: string;

async function connectedClient() {
  const server = createServer(brainDir, { kind: "none" }, BRAIN);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return { server, client };
}

beforeEach(async () => {
  vi.stubEnv("COMMONWEALTH_AUTHOR", "Test Contributor");
  vi.stubEnv("COMMONWEALTH_AUTHOR_EMAIL", "contributor@example.com");
  brainDir = await fs.mkdtemp(path.join(tmpdir(), "commonwealth-mcp-resources-"));
  await initBrain(brainDir, { name: BRAIN });
});

afterEach(async () => {
  await fs.rm(brainDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("MCP resources (#217)", () => {
  it("advertises the resources capability", async () => {
    const { client, server } = await connectedClient();
    expect(client.getServerCapabilities()?.resources).toBeDefined();
    await client.close();
    await server.close();
  });

  it("lists the map, one index per kind, and individual notes", async () => {
    await writeNote(brainDir, { kind: "memory", title: "OAuth device flow", body: "detail" });
    await writeNote(brainDir, { kind: "decision", title: "Chose Postgres", body: "why" });
    await regenerateDerived(brainDir);

    const { client, server } = await connectedClient();
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);

    expect(uris).toContain(`commonwealth://${BRAIN}/COMMONWEALTH.md`);
    expect(uris).toContain(`commonwealth://${BRAIN}/memory`);
    expect(uris).toContain(`commonwealth://${BRAIN}/decision`);
    expect(uris).toContain(`commonwealth://${BRAIN}/work-state`);
    expect(uris).toContain(`commonwealth://${BRAIN}/person`);
    // Two individual-note resources (two-segment URIs), titled with the note title.
    const notes = resources.filter((r) => r.uri.split("/").length === 5);
    expect(notes).toHaveLength(2);
    expect(notes.map((n) => n.title).sort()).toEqual(["Chose Postgres", "OAuth device flow"]);

    await client.close();
    await server.close();
  });

  it("reads the map, a kind index, and an individual note", async () => {
    const note = await writeNote(brainDir, {
      kind: "memory",
      title: "OAuth device flow",
      body: "The service authenticates via the device flow.",
    });
    await regenerateDerived(brainDir);
    const { client, server } = await connectedClient();

    const map = await client.readResource({ uri: `commonwealth://${BRAIN}/COMMONWEALTH.md` });
    expect((map.contents[0] as { text: string }).text).toContain("Commonwealth");

    const index = await client.readResource({ uri: `commonwealth://${BRAIN}/memory` });
    const indexText = (index.contents[0] as { text: string }).text;
    expect(indexText).toContain("OAuth device flow");
    expect(indexText).toContain(note.frontmatter.id);

    const read = await client.readResource({
      uri: `commonwealth://${BRAIN}/memory/${note.frontmatter.id}`,
    });
    const noteText = (read.contents[0] as { text: string }).text;
    expect(noteText).toContain("# OAuth device flow");
    expect(noteText).toContain("authenticates via the device flow");

    await client.close();
    await server.close();
  });

  it("marks a superseded note in read output but still serves it", async () => {
    const winner = await writeNote(brainDir, {
      kind: "memory",
      title: "New fact",
      body: "current",
    });
    const old = await writeNote(brainDir, {
      kind: "memory",
      title: "Old fact",
      body: "outdated",
      fields: { status: "superseded", superseded_by: winner.frontmatter.id },
    });
    const { client, server } = await connectedClient();

    const read = await client.readResource({
      uri: `commonwealth://${BRAIN}/memory/${old.frontmatter.id}`,
    });
    const text = (read.contents[0] as { text: string }).text;
    expect(text).toContain("Superseded");
    expect(text).toContain(winner.frontmatter.id);
    expect(text).toContain("outdated"); // still readable

    await client.close();
    await server.close();
  });

  it("throws a proper error for an unknown note", async () => {
    const { client, server } = await connectedClient();
    await expect(
      client.readResource({ uri: `commonwealth://${BRAIN}/memory/does-not-exist` }),
    ).rejects.toThrow();
    await client.close();
    await server.close();
  });

  it("emits notifications/resources/list_changed after a remember write lands", async () => {
    const { client, server } = await connectedClient();
    let fired = 0;
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
      fired += 1;
    });

    const res = await client.callTool({
      name: "remember",
      arguments: { kind: "memory", title: "A fresh fact", body: "worth remembering" },
    });
    expect(res.isError).toBeFalsy();
    // The InMemory transport delivers the notification on the microtask queue.
    await new Promise((r) => setTimeout(r, 20));
    expect(fired).toBeGreaterThan(0);

    await client.close();
    await server.close();
  });

  it("caps the note list and emits a '…N more' sentinel (no silent truncation)", async () => {
    const extra = 3;
    for (let i = 0; i < RESOURCE_LIST_CAP + extra; i += 1) {
      // Distinct created dates so the most-recent-first ordering is deterministic.
      const day = String((i % 28) + 1).padStart(2, "0");
      await writeNote(brainDir, {
        kind: "memory",
        title: `note ${i}`,
        body: "x",
        created: `2026-01-${day}`,
      });
    }

    const listings = await listBrainResources(brainDir, BRAIN);
    const noteListings = listings.filter((r) => r.uri.split("/").length === 5);
    // Capped notes: exactly the cap, plus the single sentinel entry.
    const sentinel = listings.find((r) => r.uri === moreResourceUri(BRAIN));
    const realNotes = noteListings.filter((r) => r.uri !== moreResourceUri(BRAIN));
    expect(realNotes).toHaveLength(RESOURCE_LIST_CAP);
    expect(sentinel).toBeDefined();
    expect(sentinel?.title).toContain(`${extra} more`);
  });
});
