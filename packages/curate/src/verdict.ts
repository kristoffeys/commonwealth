import { makeNoteId, today, type NewNoteInput } from "@cmnwlth/core";

/**
 * A single LLM curation verdict for one candidate note (ADR-0030). Produced by the classifier that
 * runs in the plugin hook layer (the ADR-0027 host runtime); APPLIED here, deterministically. The
 * shape is the capture contract between the hook layer and curate.
 *
 * - `judge` — the durability judge: `trivia` filters ephemera a length check can't ("would a
 *   teammate acting in 3 months want this?"); `durable` keeps it.
 * - `consolidation` — how the candidate relates to the nearest CANON note (`targetId`):
 *   - `distinct` — unrelated / genuinely new (the fail-safe default; stage as-is);
 *   - `duplicate` — same fact restated (reject, `duplicateOf: targetId`);
 *   - `supersedes` — same subject, this newer state/decision replaces the target (stage the new
 *     note AND mark the target superseded);
 *   - `contradicts` — same subject, incompatible claim, neither obviously newer (stage anyway,
 *     flagged — NEVER auto-rejected, that is the whole point of #214).
 * - `targetId` — the canon note the consolidation relation is about (required for any non-distinct
 *   consolidation to take effect; a missing/unknown target degrades to distinct).
 * - `reason` — the classifier's one-line rationale, logged for auditability.
 */
export interface CurationVerdict {
  judge: "durable" | "trivia";
  consolidation: "distinct" | "duplicate" | "supersedes" | "contradicts";
  targetId?: string;
  reason?: string;
}

/**
 * A capture candidate that may carry an LLM {@link CurationVerdict} from the hook layer, plus the
 * ids of the deterministic nearest-canon neighbors it was classified against.
 *
 * `neighborIds` is pipeline METADATA, not model output: the hook derives it from `curate neighbors`
 * (which ranks against real canon, offline) and carries it across the classify → capture boundary.
 * It is the allow-list a verdict's `targetId` is clamped to — so a prompt-injected classifier that
 * emits a `targetId` referencing an arbitrary note (to drop a real fact) is rejected as malformed
 * and degraded to DISTINCT. Absent (a trusted direct caller, e.g. a seed import) → the clamp does
 * not apply; those callers are not the injection surface.
 */
export interface AnnotatedCandidate extends NewNoteInput {
  verdict?: unknown;
  neighborIds?: string[];
}

const JUDGE_VALUES = new Set(["durable", "trivia"]);
const CONSOLIDATION_VALUES = new Set(["distinct", "duplicate", "supersedes", "contradicts"]);

/**
 * Coerce an untrusted verdict object into a well-formed {@link CurationVerdict}, or `undefined`
 * when it is absent/malformed. The fail-safe posture of ADR-0030 lives here: an unreadable verdict
 * — or one missing the target a consolidation needs — is treated as **DISTINCT + durable** (stage
 * as today), so a classifier or transport glitch can never silently drop or merge a fact. Only an
 * explicit, valid `trivia` / `duplicate` / `supersedes` / `contradicts` verdict changes behavior.
 */
export function parseVerdict(raw: unknown): CurationVerdict | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;

  const judge = JUDGE_VALUES.has(obj.judge as string)
    ? (obj.judge as CurationVerdict["judge"])
    : "durable";
  let consolidation = CONSOLIDATION_VALUES.has(obj.consolidation as string)
    ? (obj.consolidation as CurationVerdict["consolidation"])
    : "distinct";
  const targetId =
    typeof obj.targetId === "string" && obj.targetId.trim().length > 0
      ? obj.targetId.trim()
      : undefined;
  const reason =
    typeof obj.reason === "string" && obj.reason.trim().length > 0 ? obj.reason.trim() : undefined;

  // A consolidation relation is meaningless without a target — degrade to DISTINCT rather than act
  // on a half-formed verdict (never merge/supersede/flag against an unknown note).
  if (consolidation !== "distinct" && !targetId) consolidation = "distinct";

  return {
    judge,
    consolidation,
    ...(targetId ? { targetId } : {}),
    ...(reason ? { reason } : {}),
  };
}

/** The result of applying a verdict to one candidate before it reaches the deterministic gate. */
export type VerdictPlan =
  | { action: "reject"; reason: "llm-trivia" | "llm-duplicate"; duplicateOf?: string }
  | {
      action: "stage";
      input: NewNoteInput;
      supersedes?: string;
      contradicts?: string;
      /** Set when a consolidation verdict was CLAMPED to DISTINCT (unsafe target); an audit reason. */
      clamped?: string;
    };

/** Context {@link planCandidate} clamps consolidation targets against (defense in depth). */
export interface PlanContext {
  /**
   * All ids that currently exist in canon + staging. A `duplicate` verdict whose `targetId` is not
   * among them is clamped to DISTINCT even when it slipped the neighbor-set check — a fact is never
   * dropped in favor of a note that does not exist (belt-and-braces over the neighbor clamp).
   */
  existingIds?: Set<string>;
}

/** The audit reasons a consolidation verdict can be clamped to DISTINCT for. */
export const CLAMP_NOT_NEIGHBOR = "target-not-in-neighbor-set";
export const CLAMP_NOT_IN_CANON = "duplicate-target-not-in-canon";

/**
 * The `contradicted` tag {@link @cmnwlth/core!computeBrainHealth} already counts (#107/#214). A
 * contradiction-flagged note carries both the structured `contradicts: [targetId]` frontmatter
 * link AND this tag, so the write-time signal shows up in `health` immediately.
 */
export const CONTRADICTED_TAG = "contradicted";

/**
 * Turn one annotated candidate into a {@link VerdictPlan}: what curate should do with it before the
 * deterministic secret/dedup/validation gate runs. For `supersedes`/`contradicts` the returned
 * `input` is stamped with a trusted, pre-computed id so the caller can correlate the staged note
 * back to its consolidation target after the gate (which may reject other candidates and break
 * positional alignment). `contradicts` additionally injects the `contradicts` frontmatter field and
 * the {@link CONTRADICTED_TAG}. Pure apart from the random id suffix.
 *
 * **Target clamping (the injection defense).** A consolidation verdict may only drop (`duplicate`)
 * or merge (`supersedes`/`contradicts`) a candidate against a note the DETERMINISTIC neighbor step
 * actually surfaced for THIS candidate. When `candidate.neighborIds` is present (always so in the
 * hook pipeline), a `targetId` outside that set is treated as malformed → DISTINCT with an audit
 * `clamped` reason. `duplicate` additionally requires the target to exist in canon+staging
 * ({@link PlanContext.existingIds}), so a fabricated id can never destructively drop a real fact
 * even on a trusted path. This upholds ADR-0030's fail-safe: only a VALID verdict changes behavior.
 */
export function planCandidate(candidate: AnnotatedCandidate, ctx: PlanContext = {}): VerdictPlan {
  const { verdict: rawVerdict, neighborIds, ...base } = candidate;
  const verdict = parseVerdict(rawVerdict);

  // Durability judge first: trivia never reaches the gate (logged, never staged).
  if (verdict?.judge === "trivia") {
    return { action: "reject", reason: "llm-trivia" };
  }

  const consolidation = verdict?.consolidation ?? "distinct";
  const targetId = verdict?.targetId;
  if (consolidation !== "distinct" && targetId) {
    // Clamp 1 (all kinds): the target MUST be one of this candidate's deterministic neighbors.
    // Skip only when no neighbor set was transported (a trusted, non-pipeline caller).
    if (Array.isArray(neighborIds) && !neighborIds.includes(targetId)) {
      return { action: "stage", input: base, clamped: CLAMP_NOT_NEIGHBOR };
    }

    if (consolidation === "duplicate") {
      // Clamp 2 (duplicate only, destructive path): the target must actually exist. Neighbors are
      // canon-derived so this is redundant when the neighbor clamp ran, but it also guards the
      // no-neighborIds path where a fabricated id would otherwise silently drop the candidate.
      if (ctx.existingIds && !ctx.existingIds.has(targetId)) {
        return { action: "stage", input: base, clamped: CLAMP_NOT_IN_CANON };
      }
      return { action: "reject", reason: "llm-duplicate", duplicateOf: targetId };
    }

    // supersedes / contradicts: stage with a trusted, pre-assigned id (survives gate + promotion).
    const id = makeNoteId(base.title, base.created ?? today());
    if (consolidation === "supersedes") {
      // Stamp the forward link `supersedes: [targetId]` on the new note (bidirectional with the
      // target's `superseded_by`, and the pending-queue annotation when autoPromote is off). Valid
      // for decisions; kept via frontmatter passthrough for memory.
      const fields = { ...(base.fields ?? {}), supersedes: [targetId] };
      return { action: "stage", input: { ...base, id, fields }, supersedes: targetId };
    }
    const tags = [...new Set([...(base.tags ?? []), CONTRADICTED_TAG])];
    const fields = { ...(base.fields ?? {}), contradicts: [targetId] };
    return { action: "stage", input: { ...base, id, tags, fields }, contradicts: targetId };
  }

  // DISTINCT / durable / malformed → today's behavior exactly.
  return { action: "stage", input: base };
}
