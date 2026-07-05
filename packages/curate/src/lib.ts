/**
 * Library surface for `@cmnwlth/curate` — the curation engine, importable by other
 * packages (e.g. the MCP server's `remember`, #82) WITHOUT running the CLI. `index.ts` is the
 * `commonwealth-curate` binary (it calls `main()` on import + carries a shebang), so it must
 * never be imported as a module; this entry re-exports the pure pieces instead.
 */
export { captureCandidates, type CaptureResult } from "./capture.js";
export {
  consolidateCanon,
  DEFAULT_CONSOLIDATE_THRESHOLD,
  type ConsolidateOptions,
  type ConsolidationResult,
  type Supersession,
} from "./consolidate.js";
export {
  curate,
  defaultCurator,
  type Assessment,
  type CurateResult,
  type Curator,
  type RejectedCandidate,
} from "./curate.js";
export { approve, approveAll, listPending, reject } from "./review.js";
export { listStaged, stageNote, stagedAbsPath, stagingRoot } from "./staging.js";
export { selectRelevant } from "./relevance.js";
export { formatContext } from "./context.js";
export { addAllow, addDeny, isInScope, loadUserConfig } from "./scope.js";
