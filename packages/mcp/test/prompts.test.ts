import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initBrain } from "@cmnwlth/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROMPTS } from "../src/prompts.js";
import { createServer } from "../src/server.js";

/** Upstream command dir the prompts are ported from — the drift guard reads these files. */
const commandsDir = fileURLToPath(new URL("../../plugin/commands", import.meta.url));

let brainDir: string;

async function connectedClient() {
  const server = createServer(brainDir, { kind: "none" }, "test-brain");
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return { server, client };
}

beforeEach(async () => {
  brainDir = await fs.mkdtemp(path.join(tmpdir(), "commonwealth-mcp-prompts-"));
  await initBrain(brainDir, { name: "test-brain" });
});

afterEach(async () => {
  await fs.rm(brainDir, { recursive: true, force: true });
});

describe("MCP prompts (#216)", () => {
  it("advertises the prompts capability", async () => {
    const { client, server } = await connectedClient();
    expect(client.getServerCapabilities()?.prompts).toBeDefined();
    await client.close();
    await server.close();
  });

  it("lists the six ported command prompts with argument metadata", async () => {
    const { client, server } = await connectedClient();
    const { prompts } = await client.listPrompts();
    const names = prompts.map((p) => p.name).sort();
    expect(names).toEqual(["ask", "decide", "promote", "recall", "remember", "status"]);

    const ask = prompts.find((p) => p.name === "ask");
    expect(ask?.arguments?.map((a) => a.name)).toEqual(["question"]);
    expect(ask?.arguments?.[0].required).toBe(true);

    const remember = prompts.find((p) => p.name === "remember");
    expect(remember?.arguments?.map((a) => a.name).sort()).toEqual(["kind", "text"]);
    expect(remember?.arguments?.find((a) => a.name === "kind")?.required).toBe(false);

    await client.close();
    await server.close();
  });

  it("renders `ask` with the question interpolated into the message", async () => {
    const { client, server } = await connectedClient();
    const res = await client.getPrompt({
      name: "ask",
      arguments: { question: "why did we pick Postgres?" },
    });
    const text = res.messages.map((m) => (m.content as { text: string }).text).join("\n");
    expect(text).toContain("why did we pick Postgres?");
    expect(text).toContain("with faithful citations");
    await client.close();
    await server.close();
  });

  it("renders `decide` with what/why/deciders and omits absent optional args", async () => {
    const { client, server } = await connectedClient();
    const withAll = await client.getPrompt({
      name: "decide",
      arguments: { what: "Adopt trunk-based dev", why: "faster integration", deciders: "kristof" },
    });
    const t1 = (withAll.messages[0].content as { text: string }).text;
    expect(t1).toContain("Adopt trunk-based dev");
    expect(t1).toContain("faster integration");
    expect(t1).toContain("kristof");

    const minimal = await client.getPrompt({
      name: "decide",
      arguments: { what: "Adopt trunk-based dev" },
    });
    const t2 = (minimal.messages[0].content as { text: string }).text;
    expect(t2).toContain("Adopt trunk-based dev");
    expect(t2).not.toContain("**Why:**");
    expect(t2).not.toContain("**Deciders:**");

    await client.close();
    await server.close();
  });

  it("renders `status` (no arguments)", async () => {
    const { client, server } = await connectedClient();
    const res = await client.getPrompt({ name: "status" });
    const text = (res.messages[0].content as { text: string }).text;
    expect(text).toContain("quick health check");
    await client.close();
    await server.close();
  });

  // DRIFT GUARD: every prompt's declared anchors must appear verbatim in BOTH the rendered prompt
  // and its upstream command file. If someone edits packages/plugin/commands/*.md, this names the
  // prompt (and anchor) that diverged, forcing the single-source port to be re-synced.
  describe("drift guard — prompt text tracks packages/plugin/commands/*.md", () => {
    for (const def of PROMPTS) {
      it(`${def.name} anchors are present in the command file and the rendered prompt`, async () => {
        const commandText = await fs.readFile(path.join(commandsDir, def.commandFile), "utf8");
        // Fill required args with placeholders so render() produces a complete body.
        const args: Record<string, string> = {};
        for (const a of def.args) args[a.name] = `<${a.name}>`;
        const rendered = def.render(args);
        for (const anchor of def.driftAnchors) {
          expect(commandText, `anchor missing from ${def.commandFile}`).toContain(anchor);
          expect(rendered, `anchor missing from rendered ${def.name}`).toContain(anchor);
        }
      });
    }
  });
});
