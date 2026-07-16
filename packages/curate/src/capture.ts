import {
  attributeNoteInputs,
  ensureContributorPerson,
  isFeatureEnabled,
  listNotes,
  supersedeNote,
  type ContributorIdentity,
  type NewNoteInput,
} from "@cmnwlth/core";
import { curate, type CurateResult, type Curator } from "./curate.js";
import { approve, reject } from "./review.js";
import { listStaged, reassignStagedContributor } from "./staging.js";
import { planCandidate, type AnnotatedCandidate } from "./verdict.js";

async function rollbackStagedAttribution(
  brainDir: string,
  staged: CurateResult["staged"],
  cause: unknown,
): Promise<never> {
  const cleanupErrors: unknown[] = [];
  for (const note of staged) {
    try {
      await reject(brainDir, note.frontmatter.id);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [cause, ...cleanupErrors],
      "contributor creation failed and staged attribution rollback was incomplete",
    );
  }
  throw cause;
}

/** One applied consolidation link: the new note's id and the canon note it relates to (ADR-0030). */
export interface ConsolidationLink {
  /** Id of the new (staged/promoted) note. */
  id: string;
  /** Id of the canon note it supersedes / contradicts. */
  targetId: string;
}

/** Result of {@link captureCandidates}: the staging outcome plus any notes auto-promoted. */
export interface CaptureResult extends CurateResult {
  /** Canonical repo-relative paths of notes promoted straight to canon (autoPromote). */
  promoted: string[];
  /** Stable contributor-person id attached to this batch, when it was person-authored. */
  contributorPersonId?: string;
  /**
   * New notes that SUPERSEDED an older canon note (ADR-0030): the target's `status`/`superseded_by`
   * were updated. Populated only when the new note actually landed in canon (autoPromote on); with
   * autoPromote off the intent rides the staged note's `supersedes` frontmatter for review instead.
   */
  superseded: ConsolidationLink[];
  /** New notes flagged as CONTRADICTING a canon note (kept, never auto-rejected; ADR-0030 / #214). */
  contradictions: ConsolidationLink[];
  /** Count of candidates the durability judge filtered as trivia (logged, never staged). */
  triviaFiltered: number;
  /**
   * Count of consolidation verdicts CLAMPED to DISTINCT (ADR-0030): a `duplicate`/`supersedes`/
   * `contradicts` whose `targetId` was outside the candidate's neighbor set (or, for duplicate, not
   * in canon). The candidate is kept as-is — a misbehaving/injected classifier can never drop a
   * fact — and this count makes that visible in the audit trail rather than silent.
   */
  clamped: number;
}

export interface CaptureOptions {
  /** Trusted local person responsible for these candidates; omitted for impersonal imports. */
  contributor?: ContributorIdentity;
}

/**
 * Capture agent-proposed notes (ADR-0007 #9), applying any LLM curation verdicts (ADR-0030) the
 * hook layer annotated each candidate with. A SessionEnd/Stop hook calls this with the candidates
 * it extracted; extracting them — and classifying them — is the hook's job, not this package's.
 * Here we APPLY verdicts deterministically, then gate, stage, and (by default) promote:
 *
 * 1. **Durability judge / consolidation verdict** ({@link planCandidate}) runs first: `trivia` is
 *    filtered (reason `llm-trivia`, never staged); a `duplicate` is rejected (`llm-duplicate`,
 *    `duplicateOf`); `supersedes`/`contradicts` are stamped with a trusted id + the relevant
 *    frontmatter so they can be wired up after the gate; anything absent/malformed is DISTINCT —
 *    byte-identical to the pre-ADR-0030 behavior (the non-negotiable fail-safe).
 * 2. Survivors run through {@link curate} (the deterministic secret/dedup/validation gate — still
 *    fully in force), then, unless the brain turned `autoPromote` off, each freshly-staged note is
 *    approved straight into canon (ADR-0014).
 * 3. For a `supersedes` verdict whose new note actually reached canon, the TARGET canon note is
 *    marked superseded (`status` + `superseded_by`) — supersede-not-delete. With autoPromote off
 *    the target is left untouched (the new note isn't canon yet); the `supersedes` frontmatter link
 *    surfaces the pending consolidation for the curator (#198).
 */
export async function captureCandidates(
  brainDir: string,
  candidates: AnnotatedCandidate[],
  curator?: Curator,
  options: CaptureOptions = {},
): Promise<CaptureResult> {
  // (1) Apply verdicts BEFORE attribution/gating. Trivia + duplicate never reach the gate; the rest
  // become plain NewNoteInputs (supersedes/contradicts carry a trusted id + stamped frontmatter).
  //
  // Build the allow-list a consolidation `targetId` is clamped against: all ids in canon + staging.
  // A verdict citing a note outside the candidate's neighbor set (or, for duplicate, outside this
  // set) is degraded to DISTINCT — so an injected classifier can never drop a real fact (ADR-0030).
  const canonAtEntry = await listNotes(brainDir);
  const stagedAtEntry = await listStaged(brainDir);
  const existingIds = new Set<string>([
    ...canonAtEntry.map((n) => n.frontmatter.id),
    ...stagedAtEntry.map((n) => n.frontmatter.id),
  ]);

  const preRejected: CurateResult["rejected"] = [];
  const toStage: NewNoteInput[] = [];
  const supersedesById = new Map<string, string>();
  const contradictsById = new Map<string, string>();
  let triviaFiltered = 0;
  let clamped = 0;
  for (const candidate of candidates) {
    const plan = planCandidate(candidate, { existingIds });
    if (plan.action === "reject") {
      if (plan.reason === "llm-trivia") triviaFiltered += 1;
      const { verdict: _drop, neighborIds: _n, ...bare } = candidate;
      preRejected.push({
        candidate: bare,
        reason: plan.reason,
        ...(plan.duplicateOf ? { duplicateOf: plan.duplicateOf } : {}),
      });
      continue;
    }
    if (plan.clamped) {
      clamped += 1;
      console.error(
        `[commonwealth-curate] verdict clamped to distinct (${plan.clamped}); ` +
          `keeping candidate "${plan.input.title}" rather than dropping it against an unvetted target.`,
      );
    }
    toStage.push(plan.input);
    if (plan.supersedes && plan.input.id) supersedesById.set(plan.input.id, plan.supersedes);
    if (plan.contradicts && plan.input.id) contradictsById.set(plan.input.id, plan.contradicts);
  }

  // (2) Attribution + deterministic gate + autoPromote — the pre-ADR-0030 flow, unchanged.
  const attribution = options.contributor
    ? await attributeNoteInputs(brainDir, toStage, options.contributor)
    : null;
  const inputs = attribution?.candidates ?? toStage;
  const result = await curate(brainDir, inputs, curator);
  let contributorPersonId: string | undefined;
  if (attribution && options.contributor && result.staged.length > 0) {
    try {
      const person = await ensureContributorPerson(brainDir, options.contributor);
      if (person.frontmatter.id !== attribution.personId) {
        for (let index = 0; index < result.staged.length; index += 1) {
          result.staged[index] = await reassignStagedContributor(
            brainDir,
            result.staged[index]!,
            attribution.personId,
            person.frontmatter.id,
          );
        }
      }
      contributorPersonId = person.frontmatter.id;
    } catch (error) {
      await rollbackStagedAttribution(brainDir, result.staged, error);
    }
  }
  const promoted: string[] = [];
  const autoPromote = await isFeatureEnabled(brainDir, "autoPromote");
  if (result.staged.length > 0 && autoPromote) {
    for (const note of result.staged) {
      promoted.push(await approve(brainDir, note.frontmatter.id));
    }
  }

  // Ids that actually cleared the gate (a supersedes/contradicts candidate can still be dropped as
  // too-thin / a lexical duplicate / secret-bearing — then its consolidation must NOT fire).
  const stagedIds = new Set(result.staged.map((n) => n.frontmatter.id));

  // (3) Wire up consolidations for notes that survived. Contradictions are already recorded on the
  // note (frontmatter `contradicts` + `contradicted` tag); we only report them here. Supersession
  // mutates the TARGET, so it's applied only when the new note reached canon (autoPromote on).
  const contradictions: ConsolidationLink[] = [];
  for (const [id, targetId] of contradictsById) {
    if (stagedIds.has(id)) contradictions.push({ id, targetId });
  }
  const superseded: ConsolidationLink[] = [];
  if (autoPromote) {
    for (const [id, targetId] of supersedesById) {
      if (!stagedIds.has(id)) continue;
      // The target is pre-existing canon (a superseder's target came from the neighbor set), so it
      // was captured at entry — reuse that snapshot rather than re-listing after promotion.
      const target = canonAtEntry.find((n) => n.frontmatter.id === targetId);
      // Only supersede-able kinds carry status/superseded_by; supersedeNote no-ops otherwise. A
      // missing/unknown target is left alone — never drop or merge against a note we can't find.
      if (!target) continue;
      await supersedeNote(brainDir, target.path, id);
      superseded.push({ id, targetId });
    }
  }

  return {
    ...result,
    rejected: [...preRejected, ...result.rejected],
    promoted,
    superseded,
    contradictions,
    triviaFiltered,
    clamped,
    ...(contributorPersonId ? { contributorPersonId } : {}),
  };
}
