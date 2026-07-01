import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initBrain } from "@commons/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

let brainDir: string;

beforeEach(async () => {
  brainDir = await fs.mkdtemp(path.join(tmpdir(), "commons-mcp-server-"));
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
});
