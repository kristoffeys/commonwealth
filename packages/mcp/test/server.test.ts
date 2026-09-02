import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initBrain, writeNote } from "@cmnwlth/core";
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
  it("registers the six expected tools", async () => {
    const server = createServer(brainDir);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["ask", "list-work-state", "read", "remember", "search", "who-is"]);

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

  it("names the broken config file and parse error on corrupt-config (not 'run init') (#210)", async () => {
    const server = createServer(null, {
      kind: "corrupt-config",
      path: "/home/dev/.commonwealth/config.json",
      error: "Unexpected token } in JSON at position 42 (line 3 column 5)",
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const res = await client.callTool({ name: "search", arguments: { query: "anything" } });
    expect(res.isError).toBe(true);
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(text).toContain("/home/dev/.commonwealth/config.json");
    expect(text).toContain("unparseable");
    expect(text).toContain("line 3 column 5");
    // Must NOT send the user re-onboarding — the fix is repairing the file.
    expect(text).not.toContain("commonwealth init");

    await client.close();
    await server.close();
  });

  it("threads diagnostics/minLexicalSupport through search and ask, additive to text + structuredContent (#272)", async () => {
    await writeNote(brainDir, {
      kind: "memory",
      title: "Pineapple facts",
      body: "The pineapple grows in tropical climates.",
    });
    const server = createServer(brainDir);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // Default: no diagnostics, response shape unchanged.
    const plain = await client.callTool({ name: "search", arguments: { query: "pineapple" } });
    const plainText = (plain.content as { type: string; text: string }[])[0]!.text;
    expect(plainText).not.toContain("[diagnostics]");
    const plainResults = (plain.structuredContent as { results: Array<{ diagnostics?: unknown }> })
      .results;
    expect(plainResults[0]!.diagnostics).toBeUndefined();

    // Asked for: diagnostics reach both the text (agent-readable without structuredContent) and
    // structuredContent, with no change in which notes matched.
    const withDiag = await client.callTool({
      name: "search",
      arguments: { query: "pineapple", diagnostics: true, minLexicalSupport: 0 },
    });
    const diagText = (withDiag.content as { type: string; text: string }[])[0]!.text;
    expect(diagText).toContain("[diagnostics] tier=lexical");
    expect(diagText).toContain("threshold=n/a");
    const diagResults = (
      withDiag.structuredContent as {
        results: Array<{ diagnostics?: { tier: string; threshold: number | null } }>;
      }
    ).results;
    expect(diagResults[0]!.diagnostics).toMatchObject({ tier: "lexical", threshold: null });

    // `ask` gets the same treatment.
    const askDiag = await client.callTool({
      name: "ask",
      arguments: { question: "pineapple facts", diagnostics: true },
    });
    const askText = (askDiag.content as { type: string; text: string }[])[0]!.text;
    expect(askText).toContain("[diagnostics] tier=lexical");

    await client.close();
    await server.close();
  });
});
