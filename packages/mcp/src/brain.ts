import { resolveBrain as resolveBrainFromRegistry } from "@cmnwlth/core";

/**
 * How the MCP server should treat the current working directory:
 *  - `brain` — operate on this brain directory;
 *  - `none` — nothing maps here (the tools return the "no brain configured" error);
 *  - `corrupt-config` — the per-user config file EXISTS but doesn't parse (a hand-edit typo).
 *    Distinct from `none` so the tools can name the broken file and the parse error and say "fix
 *    or restore it", instead of the misleading "run `commonwealth init`" that points the user at
 *    re-onboarding rather than at the one-character typo that actually disabled everything (#210).
 */
export type ServerBrain =
  | { kind: "brain"; brain: string }
  | { kind: "none" }
  | { kind: "corrupt-config"; path: string; error: string };

/**
 * Resolve how the MCP server should treat the process cwd.
 *
 * Precedence:
 *  1. `COMMONWEALTH_BRAIN_DIR` — an explicit override still wins (the plugin/daemon may set it to
 *     pin a session's brain; see docs/03-distribution.md §3), even over a corrupt config file.
 *  2. `@cmnwlth/core`'s registry resolver against the process cwd — marker → ancestor brain → user
 *     config rules (ADR-0024). This resolves a directory that is itself a brain to itself, so the
 *     "cd'd into a brain" case is covered. It also distinguishes a broken config file
 *     (`corrupt-config`) from an unmapped dir (`none`/`denied`), which we surface separately (#210).
 *  3. `none` — nothing maps. We deliberately do NOT fall back to the cwd: silently adopting whatever
 *     directory Claude Code happens to launch in turns any unmapped repo into a "brain" and masks a
 *     missing mapping as success. Callers surface an explicit error instead. (#64)
 *
 * Async because the registry resolver reads the filesystem.
 */
export async function resolveServerBrain(): Promise<ServerBrain> {
  const explicit = process.env.COMMONWEALTH_BRAIN_DIR;
  if (explicit && explicit.length > 0) return { kind: "brain", brain: explicit };

  const resolved = await resolveBrainFromRegistry(process.cwd());
  if (resolved.kind === "brain") return { kind: "brain", brain: resolved.brain };
  if (resolved.kind === "corrupt-config") {
    return { kind: "corrupt-config", path: resolved.path, error: resolved.error };
  }
  // `denied` (an explicit deny rule) collapses to `none` for the server: there is no brain to
  // operate on, and the MCP tools have no privacy-gate distinction to draw.
  return { kind: "none" };
}

/**
 * Back-compat: the collapsed brain path (`string | null`) — `null` for both `none` and
 * `corrupt-config`. Kept for callers that only need "which brain, if any". New code should prefer
 * {@link resolveServerBrain} so the broken-config case can be surfaced loudly.
 */
export async function resolveBrainDir(): Promise<string | null> {
  const resolved = await resolveServerBrain();
  return resolved.kind === "brain" ? resolved.brain : null;
}
