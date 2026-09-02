/**
 * Library surface for `@cmnwlth/sync` — the sync engine, importable by other packages WITHOUT
 * running the CLI. `index.ts` is the `commonwealth-sync` binary (it calls `main()` on import +
 * carries a shebang), so it must never be imported as a module; this entry re-exports the pure
 * pieces instead. Mirrors the same split `@cmnwlth/curate` made for the MCP server's `remember`
 * (#82); the first in-process consumer is MCP-only sync for hookless hosts (#290, ADR-0040).
 *
 * The resident daemon is deliberately NOT re-exported: it is the opt-in profile ADR-0032 demoted,
 * it owns long-lived state, and it drags in `chokidar`. In-process callers want `syncOnce`.
 */
export {
  SyncEngine,
  syncOnceWithRetry,
  type SyncEngineOptions,
  type SyncRetryOptions,
  type SyncRetryResult,
  type SyncSummary,
} from "./engine.js";
export { type ResolvedConflict } from "./conflict.js";
export { formatSyncSummary } from "./format.js";
export { acquireSyncLock } from "./lock.js";
export { SerialQueue } from "./queue.js";
