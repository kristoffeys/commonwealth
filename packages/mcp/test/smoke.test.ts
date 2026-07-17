import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end guard: run the *built* binary (not source) over a real stdio transport and
 * confirm it starts and lists its tools. This is the only test that would catch a broken
 * dist entry point (e.g. a duplicate shebang), which source-imported unit tests miss.
 */

const distEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/**
 * The workspace is built ONCE in vitest globalSetup (#111); this suite must NOT run its own
 * `pnpm -r build` — a build here races the concurrently-running sibling smoke suites, whose
 * tsup `clean` wipes each `dist/` before rewriting it, so a sibling reading `dist/index.js`
 * mid-clean fails with a raw ENOENT (#253). Instead just assert the artifact is present and
 * fail loudly and actionably if it is not.
 */
function assertDistBuilt(entry: string): void {
  if (!existsSync(entry)) {
    throw new Error(
      `Built binary missing: ${entry}\nRun \`pnpm build\` first (the workspace is normally built once in vitest globalSetup).`,
    );
  }
}

let brainDir: string;

beforeAll(async () => {
  assertDistBuilt(distEntry);
  brainDir = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-mcp-smoke-"));
}, 120_000);

afterAll(async () => {
  if (brainDir) await fs.rm(brainDir, { recursive: true, force: true });
});

describe("built binary over stdio", () => {
  it("starts and lists the six tools", async () => {
    const transport = new StdioClientTransport({
      command: "node",
      args: [distEntry],
      env: { ...process.env, COMMONWEALTH_BRAIN_DIR: brainDir },
    });
    const client = new Client({ name: "smoke", version: "0.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(["ask", "list-work-state", "read", "remember", "search", "who-is"]);
    } finally {
      await client.close();
    }
  }, 30_000);
});
