import { resolveBrainDir as resolveBrainDirFromRegistry } from "@commonwealth/core";

/**
 * Resolve which brain directory the MCP server operates on.
 *
 * Precedence:
 *  1. `COMMONWEALTH_BRAIN_DIR` — an explicit override still wins (the plugin/daemon may set
 *     it to pin a session's brain; see docs/03-distribution.md §3). We honor it here, up
 *     front, so it takes precedence over the registry mappings.
 *  2. `@commonwealth/core`'s registry resolver against the process cwd — so the MCP tools
 *     (search/read/remember) hit the correct per-repo brain via the registry (marker →
 *     ancestor brain → user registry; see ADR-0011).
 *  3. The current working directory — degrade rather than crash when nothing resolves, so
 *     the server is still usable standalone against a brain you have `cd`'d into.
 *
 * Async because the registry resolver reads the filesystem.
 */
export async function resolveBrainDir(): Promise<string> {
  const explicit = process.env.COMMONWEALTH_BRAIN_DIR;
  if (explicit && explicit.length > 0) return explicit;

  const resolved = await resolveBrainDirFromRegistry(process.cwd());
  return resolved ?? process.cwd();
}
