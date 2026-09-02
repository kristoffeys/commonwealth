import type { IntakeTier } from "./schema.js";

/**
 * Anything that carries a declared ingestion tier: parsed note frontmatter, or a
 * {@link NewNoteInput} candidate on its way to being written.
 */
export interface IntakeBearing {
  intake?: IntakeTier;
}

/**
 * The ingestion trust tier of a note or candidate (ADR-0038, #274). Absent means `internal` —
 * every note written before the field existed, and every ordinary session capture, is internal by
 * documented absence. Read the tier through this rather than `?? "internal"` at each call site, so
 * "absent means internal" has exactly one implementation to change if the tiers ever grow.
 */
export function noteIntake(subject: IntakeBearing): IntakeTier {
  return subject.intake ?? "internal";
}

/**
 * Whether a note or candidate arrived from outside the brain. This is the hook a stricter
 * curation policy or an egress rule keys off (ADR-0038); today nothing in the deterministic gate
 * treats the tiers differently, and the tier is advisory — surfaced to the human and the curator
 * agent at review time.
 */
export function isExternalIntake(subject: IntakeBearing): boolean {
  return noteIntake(subject) === "external";
}
