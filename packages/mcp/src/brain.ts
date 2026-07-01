/**
 * Resolve which brain directory the MCP server operates on.
 *
 * Honors `COMMONWEALTH_BRAIN_DIR` (set by the plugin/daemon once the brain registry has
 * mapped the project → its brain repo; see docs/03-distribution.md §3). Falls back to
 * the current working directory so the server is usable standalone against a brain you
 * have `cd`'d into.
 */
export function resolveBrainDir(): string {
  return process.env.COMMONWEALTH_BRAIN_DIR ?? process.cwd();
}
