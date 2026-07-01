import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

/**
 * Commons MCP server entry point. Wires the server (built from the brain resolved via
 * `COMMONS_BRAIN_DIR` / cwd) to a stdio transport. The transport owns stdout for the
 * JSON-RPC stream, so all diagnostics go to stderr.
 */
async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[commons-mcp] connected over stdio");
}

main().catch((err) => {
  console.error("[commons-mcp] fatal:", err);
  process.exit(1);
});
