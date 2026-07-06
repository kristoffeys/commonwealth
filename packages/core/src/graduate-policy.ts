import type { Note } from "./schema.js";

/**
 * Graduation-control policy (#168, ADR-0023): decide whether a note is eligible to graduate to the
 * org-brain. Graduation is an audience-widening operation across a trust boundary, so the policy is
 * strictly **opt-in** — a note leaves its repo only when it explicitly says it may. This is the
 * gate the org-brain graduation pass (#110) applies to every project note before considering it a
 * recurrence candidate; it is intentionally decoupled from detection so the "may this leave its
 * repo?" question has one answer, testable in isolation.
 *
 * The note schema deliberately has no visibility/audience field (ADR-0023 alternatives): `source`
 * is advisory only. So eligibility rests on the explicit `graduate: true` marker plus kind/status
 * sanity, never on inference.
 */

/** Tunables for {@link isGraduatable}; all default to the conservative choice. */
export interface GraduatePolicyOptions {
  /**
   * Whether `decision` notes may graduate. Mirrors the org-brain's `autoAdr`: a team that does not
   * capture decisions as canon should not have them graduate either. Default `false` — only
   * `memory` graduates unless a decision-carrying brain opts in.
   */
  allowDecisions?: boolean;
}

/**
 * True when `note` may be proposed for graduation to the org-brain. Requires, in order:
 *
 * 1. the explicit opt-in `graduate === true` (never inferred — absent/`false` ⇒ not eligible);
 * 2. a graduatable **kind**: `memory` always; `decision` only when `opts.allowDecisions`;
 *    `work-state` (per-repo, transient) and `person` (out of scope for #110) never;
 * 3. a **live** status: `active` for memory, `accepted` for decision — a superseded/stale/proposed
 *    note is not a fact the team currently stands behind, so it must not widen its audience.
 *
 * Pure and synchronous: eligibility is a property of the note plus policy, not of any brain state.
 */
export function isGraduatable(note: Note, opts: GraduatePolicyOptions = {}): boolean {
  const fm = note.frontmatter;
  if (fm.graduate !== true) return false;
  switch (fm.kind) {
    case "memory":
      return fm.status === "active";
    case "decision":
      return opts.allowDecisions === true && fm.status === "accepted";
    default:
      // work-state and person are never graduated (see doc above).
      return false;
  }
}
