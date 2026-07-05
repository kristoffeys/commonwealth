import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initBrain } from "@cmnwlth/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

let brainDir: string;

beforeEach(async () => {
  brainDir = await fs.mkdtemp(path.join(tmpdir(), "commonwealth-mcp-server-"));
  await initBrain(brainDir, { name: "test-brain" });
});

afterEach(async () => {
  await fs.rm(brainDir, { recursive: true, force: true });
});

describe("createServer", () => {
  it("registers the five expected tools", async () => {
    const server = createServer(brainDir);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["list-work-state", "read", "remember", "search", "who-is"]);

    await client.close();
    await server.close();
  });

  it("returns an explicit 'no brain configured' error (not cwd data) when built with null", async () => {
    const server = createServer(null);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const res = await client.callTool({ name: "search", arguments: { query: "anything" } });
    expect(res.isError).toBe(true);
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(text).toContain("No Commonwealth brain is configured");

    // A write tool must refuse too — never silently write into the cwd.
    const write = await client.callTool({
      name: "remember",
      arguments: { kind: "memory", title: "should not land", body: "x" },
    });
    expect(write.isError).toBe(true);

    await client.close();
    await server.close();
  });
});
