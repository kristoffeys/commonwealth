import { loadBrainConfig } from "@cmnwlth/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveServerBrain } from "./brain.js";
import { createServer } from "./server.js";
import { createMcpSync, formatOutcome, resolveSyncOwner, type McpSync } from "./sync.js";

/**
 * Commonwealth MCP server entry point. Resolves the brain (explicit `COMMONWEALTH_BRAIN_DIR`
 * → `@cmnwlth/core`'s registry against cwd → `none`/`corrupt-config`) once at startup, builds the
 * server against it, and wires a stdio transport. When no brain resolves the server still starts,
 * but its tools report why — "no brain configured" (#64), or, when the config file is broken, that
 * it is unparseable and how to fix it (#210) — rather than silently using the cwd. The transport
 * owns stdout for the JSON-RPC stream, so all diagnostics go to stderr.
 *
 * On a host that does NOT run our lifecycle hooks the server also owns sync (#290, ADR-0040): it
 * pulls before serving and pushes what it writes. Our own plugin sets `COMMONWEALTH_MCP_SYNC=off`
 * because Claude Code and Codex already sync at their session boundaries (ADR-0032).
 */
async function main(): Promise<void> {
  const resolved = await resolveServerBrain();
  // Resolve the human-readable brain name for resource URIs (#217); fall back to the dir basename
  // (createServer's own default) if the config can't be loaded for any reason.
  const brainName =
    resolved.kind === "brain"
      ? await loadBrainConfig(resolved.brain)
          .then((c) => c.name)
          .catch(() => undefined)
      : undefined;
  // Sync ownership: `server` (default — an unknown, hookless host publishes its own writes) or
  // `host` (our plugin's hosts, which sync through the lifecycle hooks). There is nothing to sync
  // when no brain resolved.
  const sync: McpSync | null =
    resolved.kind === "brain" && resolveSyncOwner() === "server"
      ? createMcpSync(resolved.brain)
      : null;
  const server =
    resolved.kind === "brain"
      ? createServer(resolved.brain, { kind: "none" }, brainName, sync)
      : resolved.kind === "corrupt-config"
        ? createServer(null, {
            kind: "corrupt-config",
            path: resolved.path,
            error: resolved.error,
          })
        : createServer(null, { kind: "none" });
  // Pull-on-start, BEFORE serving, so the first read isn't answered from a week-old working copy —
  // but hard-capped and fail-open: a slow or unreachable remote must degrade to "serving stale
  // notes", never to "the server won't start". Past the cap the pass keeps running detached and
  // lands on its own, which is exactly how SessionStart behaves (ADR-0032 §3).
  if (sync) console.error(formatOutcome("pull-on-start", await sync.pullOnStart()));

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
