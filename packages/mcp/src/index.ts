import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveBrainDir } from "./brain.js";
import { createServer } from "./server.js";

/**
 * Commonwealth MCP server entry point. Resolves the brain (explicit `COMMONWEALTH_BRAIN_DIR`
 * → `@commonwealth/core`'s registry against cwd → cwd) once at startup, builds the server
 * against it, and wires a stdio transport. The transport owns stdout for the JSON-RPC
 * stream, so all diagnostics go to stderr.
 */
async function main(): Promise<void> {
  const brainDir = await resolveBrainDir();
  const server = createServer(brainDir);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[commonwealth-mcp] connected over stdio (brain: ${brainDir})`);
}

main().catch((err) => {
  console.error("[commonwealth-mcp] fatal:", err);
  process.exit(1);
});
