import { resolveBrainDir as resolveBrainDirFromRegistry } from "@commonwealth/core";

/**
 * Resolve which brain directory the MCP server operates on, or `null` when none is
 * configured for the current working directory.
 *
 * Precedence:
 *  1. `COMMONWEALTH_BRAIN_DIR` — an explicit override still wins (the plugin/daemon may set
 *     it to pin a session's brain; see docs/03-distribution.md §3). We honor it here, up
 *     front, so it takes precedence over the registry mappings.
 *  2. `@commonwealth/core`'s registry resolver against the process cwd — so the MCP tools
 *     (search/read/remember) hit the correct per-repo brain via the registry (marker →
 *     ancestor brain → user registry; see ADR-0011). This already resolves a directory that
 *     is *itself* a brain to itself, so the "cd'd into a brain" case is covered here.
 *  3. `null` — nothing maps. We deliberately do NOT fall back to the cwd: silently adopting
 *     whatever directory Claude Code happens to launch in turns any unmapped repo into a
 *     "brain" and masks a missing mapping as success (the surprise this fixes). Callers
 *     surface an explicit "no brain configured" error instead. (#64)
 *
 * Async because the registry resolver reads the filesystem.
 */
export async function resolveBrainDir(): Promise<string | null> {
  const explicit = process.env.COMMONWEALTH_BRAIN_DIR;
  if (explicit && explicit.length > 0) return explicit;

  return resolveBrainDirFromRegistry(process.cwd());
}
