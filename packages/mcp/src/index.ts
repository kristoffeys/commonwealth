import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveBrainDir } from "./brain.js";
import { createServer } from "./server.js";

/**
 * Commonwealth MCP server entry point. Resolves the brain (explicit `COMMONWEALTH_BRAIN_DIR`
 * → `@cmnwlth/core`'s registry against cwd → `null`) once at startup, builds the server
 * against it, and wires a stdio transport. When no brain resolves the server still starts,
 * but its tools report "no brain configured" rather than silently using the cwd (#64). The
 * transport owns stdout for the JSON-RPC stream, so all diagnostics go to stderr.
 */
async function main(): Promise<void> {
  const brainDir = await resolveBrainDir();
  const server = createServer(brainDir);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    brainDir
      ? `[commonwealth-mcp] connected over stdio (brain: ${brainDir})`
      : `[commonwealth-mcp] connected over stdio (no brain configured for ${process.cwd()}; ` +
          `tools will report this until you run \`commonwealth init\` or add a registry mapping)`,
  );
}

main().catch((err) => {
  console.error("[commonwealth-mcp] fatal:", err);
  process.exit(1);
});
