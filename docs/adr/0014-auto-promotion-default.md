# 14. Captured notes auto-promote into canon by default (opt-out review gating)

- Status: Accepted
- Date: 2026-07-01
- Deciders: kristof (owner), Claude (orchestrator)
- Relates: [ADR-0007](0007-curation-and-review-queue.md), [ADR-0009](0009-brain-config-feature-flags.md),
  amends principle 4 in `CLAUDE.md`, issue-less (owner request)

## Context

Since ADR-0007, every auto-captured note is *proposed* into a per-brain `staging/` review
queue and only becomes canon when a human approves it (`/commonwealth:promote`). `CLAUDE.md`
principle 4 states this as non-negotiable: "Auto-captured knowledge is proposed, then approved
before it becomes canon. Junk must never auto-land."

In practice, for a solo / small-team brain the always-on review gate is friction: you finish a
session, capture runs, and nothing is usable until you separately go review and approve. The
owner asked for capture to land directly in canon by default, with review gating available as
an opt-out rather than a mandate.

Two facts make this safe enough to flip the default:

1. **Curation still gates.** `curate()` runs dedup + validation before anything is staged, and
   the secret-scan scrub runs pre-commit. Auto-promotion skips the *manual review* step, not the
   automated gating — so "junk auto-lands" is mitigated, not wide open.
2. **It is a per-brain feature flag** (ADR-0009), stored in the synced `.commonwealth/config.json`,
   so a team that wants the stricter posture flips one boolean and the whole team inherits it.

## Decision

1. **Add a `autoPromote` feature flag, default `true`.** When on, `captureCandidates` approves
   each freshly-staged note straight into canon and reports the canonical paths (`promoted`).
   When off, notes stay in the review queue for `/commonwealth:promote` (the ADR-0007 behavior).
2. **It applies to the whole capture path — session-capture *and* seeding.** Seeding
   (`commonwealth-seed gather | commonwealth-curate capture`) shares the capture command, so a
   repo mine also lands in canon when the flag is on. This is the literal "no review gating
   everywhere" the owner asked for; a team that wants to review bulk mines turns the flag off.
3. **`CLAUDE.md` principle 4 is amended, not deleted.** Curation remains review-*capable*: the
   queue, `promote`/`reject`, and the scope + dedup + secret gates all stay. What changes is the
   *default* — proposed-then-auto-promoted rather than proposed-then-manually-approved.

## Consequences

- Lower friction: a captured learning is immediately usable by the next session's context
  injection and search, with no manual step.
- Higher trust demand on the capture agent + curation gating, since there is no human check by
  default. Teams that cannot accept that flip `autoPromote` to `false` (one synced boolean).
- The review queue (`staging/`) still exists and is exercised whenever the flag is off, so no
  code path is removed — this is a default change guarded by a flag, reversible per brain.
- README and `CLAUDE.md` are updated in the same change so they describe the auto-promote
  default rather than an absolute review gate.
