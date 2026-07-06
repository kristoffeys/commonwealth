# 23. Org-brain graduation: cross-brain recurrence → org-brain, opt-in and manual by default

- Status: Accepted
- Date: 2026-07-06
- Deciders: kristof (owner); Claude (orchestrator)
- Relates: [ADR-0007](0007-curation-review-gate.md) (curation/review gate),
  [ADR-0008](0008-curation-locality.md) (staging is per-user, local),
  [ADR-0014](0014-auto-promotion-default.md) (auto-promote default),
  [ADR-0015](0015-note-project-provenance.md) (note `source` provenance),
  [ADR-0019](0019-access-model-clone-on-demand.md) (clone-on-demand),
  [ADR-0021](0021-embeddings-semantic-dedup.md) (embeddings/semantic dedup),
  issues #110 (this feature), #167 (org-brain wiring), #168 (graduation-control primitive)

## Context

Teams accumulate the same fact or decision independently across several project brains
(conventions, shared infra rules, client rules). The roadmap and architecture doc name
**cross-brain graduation** as a standing open thread: promote knowledge recurring across ≥2
project brains up to an `org-brain` where everyone can find it, without silently crossing a trust
boundary.

Graduation is fundamentally an **audience-widening** operation, and Commonwealth's note schema has
**no visibility field** — `source` (ADR-0015) is advisory only. The naive design (auto-detect
recurrence, stage into the org-brain) has one acute failure mode: the "recurs across ≥2 brains"
trigger is *exactly* the case where a fact shared between two different **client** brains would be
pushed into an org-brain that both clients' teams can read. For the multi-client agency that is our
first candidate user, cross-client leakage is the headline risk, not a corner case.

Two capabilities are missing in code and are split out as prerequisites: there is no way to
**designate or enumerate** an org-brain (#167), and no primitive to say a note **may leave its
repo** (#168).

## Decision

Implement graduation as an **on-demand, single-writer batch pass** (`graduateToOrgBrain()` in
`packages/curate`, modeled on the existing `consolidateCanon()`), gated by four safety choices:

1. **Opt-in, never opt-out (#168).** A note is eligible only if it explicitly carries
   `graduate: true`. Untagged notes never leave their repo. This honors the "never promote notes
   that shouldn't leave their repo" bar literally, and needs **no schema-version bump** (the field
   is passthrough, honored by an `isGraduatable()` policy). We accept lower recall (the feature
   starts quiet until authors/curators opt notes in) as the price of safe-by-default.

2. **Surface provenance at review, don't model audience (yet).** Rather than build a visibility/
   audience model and enforce an audience-superset check now, the pass stages the candidate with
   `sources:` back-links to the ≥2 originating notes and shows the reviewer which brains it recurs
   in. A human makes the "is the org-brain a readable superset of these sources?" call at the
   manual promote gate. A first-class audience model may supersede this later.

3. **On-demand pull, not a background batch.** Graduation runs when a human invokes
   `commonwealth graduate --suggest`; detection is automatic, invocation is manual. This avoids a
   scheduled slot silently filling the org-brain queue and sidesteps cadence / review-fatigue /
   per-run-cap questions until there is evidence they are needed.

4. **Manual review by default, structurally.** Candidates are created via `curate(orgBrainDir, …)`
   — which routes through the org-brain's local `staging/` queue — and **never** via
   `captureCandidates` (the only path that can auto-promote). So graduated candidates wait for
   `/commonwealth:promote` **regardless** of any brain's `autoPromote` flag; `autoPromote` does not
   compose across the trust boundary. `curate()` also re-runs the secret + dedup + validation gate
   on the synthesized candidate.

Detection reuses the existing embeddings toolkit (ADR-0021): `loadVectors` + `cosineSimilarity`
over each brain's cached vectors, clustering same-kind notes across brains with a **dedicated,
conservative** `RECURRENCE_THRESHOLD` (0.90, distinct from the 0.85 within-brain dedup threshold),
plus a lexical corroboration floor, plus a hard "spans ≥2 distinct **brains**" bar (counted by
brain dir, since `source` is advisory and may be absent). The pass holds each mutated brain's
sync lock (org-brain for staging; a project brain's lock around any re-index), per ADR-0008.

**Federated cross-brain search is *not* required.** The minimal version is a local O(n·m) scan
over already-registered brains — honest and sufficient for the acceptance bar. An ANN/federated
index is future work for large N, not a blocker.

## Consequences

- **Positive.** No leak-by-default; the acceptance bar is met literally. No schema-version bump. No
  new audience model or scheduler to build now. Reuses the embeddings, clustering, locking, and
  curation machinery wholesale rather than adding parallel systems. Small, reviewable PRs (#167 →
  #168 → #110).
- **Negative / accepted.** Low initial recall — nothing graduates until notes are marked
  `graduate: true`. Cross-client safety rests on the human reviewer plus opt-in, not on an enforced
  audience check; if that proves insufficient we add a first-class `visibility`/`audience` field and
  supersede decision (2). Org-brain identity is a local per-machine pointer (#167), so each teammate
  wires their own — slightly off the multiplayer thesis; a synced `role: 'org'` config can upgrade
  it later. Detection is a naive linear scan; fine at team scale, needs an index later.
- **Follow-ups.** A rejected candidate must be tombstoned so the next pass does not re-propose the
  same cluster (tracked in #110). Threshold values (0.90 cosine + lexical floor + ≥2 brains) are
  conservative guesses pending calibration against a real multi-brain corpus.

## Alternatives considered

- **Opt-out tag (`no-graduate`).** Highest recall, simplest, but leaks by default — rejected
  because it contradicts the "Never" acceptance criterion and is dangerous for multi-client teams.
- **First-class `visibility` schema field + enforced audience-superset check.** The most correct
  long-term design, but requires a schema-version bump and an audience model for every brain now.
  Deferred; opt-in + surfaced provenance gets the safety guarantee at a fraction of the cost.
- **Proactive background batch.** "It just works," but reintroduces cadence, review-fatigue, and
  candidate-cap decisions with no evidence they are wanted yet. Deferred behind on-demand pull.
- **Per-brain `role: 'org'` config as the org-brain locator.** Source-of-truth-in-repo and team-
  shared, but requires loading every brain's config to find the org-brain. Deferred in favor of the
  cheap local registry pointer (#167).
