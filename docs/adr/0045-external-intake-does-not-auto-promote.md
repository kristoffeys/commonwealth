# 45. External intake does not auto-promote; bulk import lands as a promotion PR

- Status: Accepted
- Date: 2026-09-02
- Deciders: kristof (owner), Claude (orchestrator)
- Amends: [ADR-0014](0014-auto-promotion-default.md) §2 (the `autoPromote` default now has a
  scoped, explicit exception — see Decision 1)
- Relates: [ADR-0038](0038-capture-provenance-tier.md) (the `intake: external` marker this policy
  branches on, and its §Rejected note that this exact decision was deliberately deferred pending
  real data), [ADR-0008](0008-curation-locality.md) (curation locality — why the per-user `staging/`
  queue cannot be the review surface for bulk external content), [ADR-0003](0003-concurrency-model.md)
  (concurrency model — why the PR path, not the working tree, is what keeps union-merge safety at
  bulk volume), [ADR-0037](0037-purge-secrets-from-history.md) (`redact` — the tool named here as
  the answer to a genuine erasure request, so a connector never grows a second deletion path),
  [ADR-0043](0043-external-ingestion-candidate-producer-contract.md) (the runner that enforces this
  policy), issue #150, issues #288 #289 (the write-path bugs this policy sidesteps rather than
  depends on), #297 (the implementation issue)

## Context

ADR-0038 gave every note an `intake` tier (`internal`/`external`) but explicitly deferred the
policy question: "Making `autoPromote` skip external notes now… is a behaviour change we cannot yet
test against a real connector's output… choosing the policy is #150's decision to make with real
data." The #150 design investigation is that data, and it found two independent reasons to resolve
the deferral in favor of gating, not one:

**Trust.** ADR-0014's justification for defaulting `autoPromote` to `true` was "higher trust demand
on the capture agent" — an agent that watched the work happen and distilled what it saw. External
intake has no such agent: nothing witnessed the reasoning, and the candidate was extracted by a
model from text it cannot verify. The premise that made the default safe is simply absent for this
tier.

**Volume mechanics, independent of trust.** Landing bulk external content through the ordinary
working-tree write path breaks things a single session capture never would: a deterministic-id
add/add conflict (two connector runs before either pushes) gets **re-minted** into duplicates by the
sibling conflict resolver rather than caught by the collision-proof id (tracked as #288); a bulk
commit inflates the cross-process sync lock's critical section past ADR-0032's 5-second
session-start budget for every other teammate (#289); and per-project MOC files, which are tracked
but not merge-safe, get scattered into sibling junk by the same resolver (#288). None of these are
fixed by choosing a promotion policy — but the working tree is the wrong place to land bulk content
regardless of what that policy says, so this ADR does not wait on #288/#289 to pick a landing path
that avoids the working tree entirely.

## Decision

1. **`intake: external` ignores `autoPromote`.** This amends ADR-0014 §2, which today applies the
   flag uniformly to "the whole capture path — session-capture *and* seeding." It is a scoped,
   explicit carve-out, not a reversal: every capture today is `internal` (absent means `internal`,
   ADR-0038 §3), so this changes the observed behavior of exactly zero existing call sites. The
   asymmetry that makes the carve-out worth having: canon is corrected by *adding* (supersede, never
   delete), so a wrongly-auto-promoted note is strictly more expensive to fix than a note that sat
   one extra review step. A session-capture mistake is one note; an import mistake is one bad
   extraction rule times however many candidates the run produced.

2. **Bulk external content lands as a promotion PR, not through `staging/` and not through the
   local working tree.** The commit is built with git plumbing against a temporary `GIT_INDEX_FILE`
   off the fetched remote head, and a branch is pushed and opened as a PR — the exact technique
   `promote --pr` already uses (`packages/curate/src/promote-pr.ts:19-37`), reused rather than
   reinvented. `staging/` is out because it is gitignored and per-user (ADR-0008): a 500-note local
   queue is invisible to the rest of the team and reviewable only by the one machine that ran the
   import — not a workflow anyone will complete one `commonwealth promote` at a time, and not
   "shared review" in any sense ADR-0008 intended. The working tree is out because it is the
   volume-mechanics problem in Context: no sync lock is held, no `buildIndex` runs, and no local
   rebase happens during an import, so none of the three breaks above are even reachable through
   this landing path — not because they were fixed, but because the path that exposed them is no
   longer used for bulk external content.

3. **One escape hatch: `connectors.autoPromoteExternal` (default `false`).** A per-brain
   config flag, for the case ADR-0014 itself anticipated — a solo owner importing their own
   material who wants no ceremony. Off by default because the trust argument in Decision 1 applies
   to every brain until a brain's owner explicitly says otherwise for their own use.

4. **A same-path collision between two connector runs is a visible PR-merge conflict, not a
   silent duplicate.** Two `ingest` runs producing a candidate at the same deterministic path
   (ADR-0043 references the id scheme; #295 owns it) now surface as a genuine git conflict when the
   second PR tries to merge — visible, in a PR, to a human. That is a strict improvement over what
   the working-tree path would have done to the same collision (silently re-minted into two notes
   under fresh ids, per #288), and it falls out of Decision 2 rather than requiring separate
   machinery.

## Rejected

- **Leave `autoPromote` uniform and rely on the secret/sensitivity gates alone.** Those gates catch
  credentials and (once built, Phase 2) flagged sensitive topics; they do not address the trust
  asymmetry in Decision 1 or any of the volume mechanics in Context. Gating on trust and gating on
  content are different problems, and this decision only resolves the first — deliberately, since
  the second isn't built yet.
- **Route bulk external content through a higher-threshold `staging/` review.** Rejected on ADR-0008
  grounds: staging is structurally per-user and un-synced, so no threshold fixes its
  not-actually-shared-review problem at bulk scale.
- **Fix #288/#289 first and then allow bulk imports through the ordinary write path.** Even a fully
  fixed write path still holds the sync lock and does a full rebuild during an import — a cost every
  teammate pays at every import's commit, forever, regardless of whether duplicates or conflicts
  occur. The PR path avoids paying that cost at all, which #288/#289 alone do not.

## Consequences

- A 500-note import becomes reviewable with ordinary PR diff tooling instead of five hundred
  individual `commonwealth promote` decisions — a review workload that will actually get done.
- No working-tree writes during import means teammates' ADR-0032 session-start sync budget is
  untouched by a concurrent import, and no local rebase means derived files are never merged, only
  regenerated post-merge as normal.
- The escape hatch means a solo owner's workflow does not regress: `autoPromoteExternal: true` gets
  back today's zero-ceremony landing, opted into per brain, never the default.
- Trade-off accepted: bulk external content takes an extra step — opening and merging a PR — that a
  session capture never needed. That is the point, not a side effect.

## Not deciding yet

- **GDPR/erasure posture for imported personal data** (Open Question 3). If an imported note names
  a person and they request erasure, today's only tool is `commonwealth redact` (ADR-0037): a
  human-gated history rewrite plus force-push across every clone. Whether that is an acceptable
  answer to a real request, or whether external intake needs a genuine deletion path — which would
  breach supersede-not-delete for one note class, a principle-level call — is Kristof's to make, not
  decided here. Named explicitly so nobody builds a second deletion path inside a connector in the
  meantime.
- **One designated connector-running machine per brain, or any teammate** (Open Question 4). A
  single owner removes the add/add PR-collision case in Decision 4 by policy (only one machine ever
  produces a given deterministic path); "anyone" is friendlier and accepts occasional PR-level
  collisions as the cost, once #288's conflict-resolver fix lands. This ADR's landing decision holds
  under either operational model; which one a team actually runs is not decided here.
- **The review process for a promotion PR itself** — approvals required, who reviews, CI checks —
  is whatever the brain's git host (GitHub, in every case seen so far) already provides. No new
  review tooling is decided or built by this ADR.
