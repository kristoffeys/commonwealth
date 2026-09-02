# 38. Notes carry an ingestion trust tier: internal vs. external

- Status: Accepted
- Date: 2026-09-02
- Deciders: kristof (owner), Claude (orchestrator)
- Relates: [ADR-0007](0007-curation-review-gate.md) (the gate this feeds),
  [ADR-0014](0014-auto-promotion-default.md) (`autoPromote`, the default this deliberately does not
  change), [ADR-0015](0015-note-project-provenance.md) / [ADR-0031](0031-project-identity-resolved-at-read-time.md)
  (`source` / `project` — the where-from axis), [ADR-0029](0029-person-responsibility-attribution.md)
  (`author` / `author_ref` — the who axis), [data-model](../02-data-model.md),
  issue #274, prerequisite for #150 (seed connectors)
- Credit: the idea of a deliberately coarse two-value ingestion tag that the storage layer
  *receives* and never assigns itself is borrowed from the memory kernel in
  [openhuman](https://github.com/tinyhumansai/openhuman). Independently designed and implemented
  here from a plain-English description of the mechanism; no code, names, or prose were taken.

## Context

A note records **who** wrote it (`author` / `author_ref`, ADR-0029), **where** it was captured
(`source`, ADR-0015) and **which engagement** it belongs to (`project`, ADR-0031). Nothing records
**how** it entered the brain. A fact distilled from a teammate reasoning out loud in a live session
and a fact scraped out of a synced Slack thread or a ticket description are, at the moment a human
or the curator agent reviews the queue, indistinguishable: same shape, same fields, same authority.

That is tolerable while every note comes out of a session. It stops being tolerable at #150
(pluggable seed connectors for Notion / Slack / Productive). With `autoPromote: true` — the default
since ADR-0014, justified there by the automated gate plus "higher trust demand on the capture
agent" — the first connector we ship would flood canon with machine-scraped content that the next
session's context injection reads as settled team knowledge. The gate cannot apply different
scrutiny to it because it cannot *see* the difference, and neither can the reviewer.

## Decision

1. **One optional frontmatter field, `intake`, with exactly two values: `internal` and `external`.**
   `internal` = distilled from work happening inside the team's own sessions. `external` = ingested
   from a system outside the brain. The name completes the existing family: `author` answers who,
   `source`/`project` answer where-from, `intake` answers how it got in. It is read as a **trust
   tier**, not a channel taxonomy.

2. **Two coarse values, not a rich taxonomy.** Every consumer of this field is answering one
   question — "how much scrutiny does this deserve?" — and a taxonomy makes each of them switch on
   a growing list, with the sure result that a newly-added value falls through every switch into
   whatever the default happens to be. Which system a note came from, which channel, which message
   id: that is the connector's business, and it belongs in the connector's own metadata (tags,
   `sources`, body links), not in the tier the gate branches on.

3. **Absent means `internal`.** The field is additive and optional, so every note in every existing
   brain stays valid, no `.commonwealth/schema-version` bump is needed, and an ordinary session
   capture writes a note byte-identical to a pre-ADR-0038 one. Absence is a *documented* tier, not
   "unknown": `noteIntake()` in `@cmnwlth/core` is the single place that defaults it, so no call
   site is free to invent its own reading. `external` is therefore always an explicit, deliberate
   mark — the direction that matters, since the failure we are guarding is external content
   *passing* as internal, never the reverse.

4. **Stamped once per run, by the trusted caller, never self-assigned.** The tier is an argument to
   `captureCandidates` (`CaptureOptions.intake`; `commonwealth-curate capture --external` on the
   CLI), declared for the whole ingestion run. A tier a *candidate* carries for itself is discarded
   in favour of the run's, in both directions. This is not defensiveness for its own sake: a
   candidate is frequently extracted by a model FROM the very external content whose trust we are
   grading, so letting the candidate declare its own tier would let the untrusted input mark itself
   trusted. Same reason `writeNote` keeps `intake` among the trusted derived keys that win over
   caller-supplied `fields` (the #77 id-injection guard).

5. **Never rewritten on an existing note.** Promotion moves a staged note's bytes into canon
   unchanged; consolidation supersedes rather than edits. A note read back never acquires a tier it
   was not written with, and no pass backfills one — the same no-frontmatter-rewrite discipline
   ADR-0031 holds `source` to. A brain's historical notes stay internal-by-absence, correctly: they
   *were* captured from sessions.

6. **The tier is recorded and surfaced now; policy is deferred.** What ships here:
   - Capture stamps it.
   - The review queue shows it: `commonwealth pending` marks an external line `⇢ external intake`,
     and the curator agent (which reads that same listing) is instructed to prefer `hold` over
     `promote` for one and to say so in its reason.
   - `isExternalIntake()` is the seam a stricter policy keys off. Because the tier rides on the
     `NewNoteInput` that reaches `Curator.assess`, a pluggable curator (the ADR-0007 seam) can
     already apply harsher thresholds to external candidates without any further plumbing.

   What does **not** change: the deterministic gate treats both tiers identically, and
   `autoPromote` (ADR-0014) does exactly what it does today for every note. Today's captures are
   all internal, so today's behaviour is unchanged by construction.

## Rejected

- **A richer provenance taxonomy** (`session` / `slack` / `notion` / `ticket` / `import`): the
  per-connector detail is real, but it belongs to the connector, and encoding it in the trust field
  guarantees a future value silently inheriting the wrong default. See decision 2.
- **A boolean (`ingested: true`)**, mirroring `graduate`. Terser, but it cannot say `internal`
  explicitly, and a tier the ADR and the review UI both want to *name* reads better as an enum.
- **Making `autoPromote` skip external notes now.** Tempting — it is the obvious eventual policy —
  but it is a behaviour change we cannot yet test against a real connector's output, and shipping
  it before #150 means the first connector's authors inherit a policy nobody validated. Recording
  the tier is the prerequisite; choosing the policy is #150's decision to make with real data.
- **Deriving the tier at read time from `source`** (e.g. "a source that looks like a Slack workspace
  is external"). Inference, not declaration — the same trap ADR-0031 §5 refused for project
  linking. A wrong silent trust grade is worse than an absent one.

## Consequences

- #150 has its prerequisite: a connector declares `--external` once and every note it produces is
  distinguishable forever, at review time and in canon.
- A reviewer and the curator agent can see, at the moment of decision, that a candidate is
  machine-scraped rather than reasoned — which is where the judgement actually happens.
- Zero migration. No schema-version bump, no backfill, no file moves; existing brains and existing
  notes are untouched, and a session capture's on-disk bytes do not change.
- Trade-off accepted: for now the tier is *advisory*. An `external` note with `autoPromote: true`
  still lands in canon. That is a deliberate, documented gap rather than an oversight, and the test
  suite pins it so tightening it later is a visible edit rather than a drift.
- Egress and org-brain graduation (ADR-0023) are natural future consumers — "do not graduate
  externally-ingested content across a trust boundary" is exactly the kind of rule this field makes
  expressible. Not decided here.

## Follow-ups (out of scope here)

- #150: the connectors themselves, and the `autoPromote` / gate policy for external content, chosen
  against a real connector's output.
- Whether `graduate` should refuse an `external` note (ADR-0023 interaction).
- Meeting-note ingestion (#270's `meeting` kind): transcripts arriving from a recorder are a likely
  `external` source, and that kind inherits `intake` from `baseShape` for free.
