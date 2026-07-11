import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveServerBrain } from "./brain.js";
import { createServer } from "./server.js";

/**
 * Commonwealth MCP server entry point. Resolves the brain (explicit `COMMONWEALTH_BRAIN_DIR`
 * → `@cmnwlth/core`'s registry against cwd → `none`/`corrupt-config`) once at startup, builds the
 * server against it, and wires a stdio transport. When no brain resolves the server still starts,
 * but its tools report why — "no brain configured" (#64), or, when the config file is broken, that
 * it is unparseable and how to fix it (#210) — rather than silently using the cwd. The transport
 * owns stdout for the JSON-RPC stream, so all diagnostics go to stderr.
 */
async function main(): Promise<void> {
  const resolved = await resolveServerBrain();
  const server =
    resolved.kind === "brain"
      ? createServer(resolved.brain)
      : resolved.kind === "corrupt-config"
        ? createServer(null, {
            kind: "corrupt-config",
            path: resolved.path,
            error: resolved.error,
          })
        : createServer(null, { kind: "none" });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    resolved.kind === "brain"
      ? `[commonwealth-mcp] connected over stdio (brain: ${resolved.brain})`
      : resolved.kind === "corrupt-config"
        ? `[commonwealth-mcp] connected over stdio (config at ${resolved.path} is unparseable: ` +
          `${resolved.error}; fix or restore it — tools will report this until you do)`
        : `[commonwealth-mcp] connected over stdio (no brain configured for ${process.cwd()}; ` +
          `tools will report this until you run \`commonwealth init\` or add a registry mapping)`,
  );
}

main().catch((err) => {
  console.error("[commonwealth-mcp] fatal:", err);
  process.exit(1);
});
