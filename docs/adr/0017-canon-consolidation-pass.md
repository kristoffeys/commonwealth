# 17. Cross-user canon consolidation pass

- Status: Accepted
- Date: 2026-07-04
- Deciders: kristof (owner), Claude (orchestrator)
- Relates: [ADR-0003](0003-concurrency-model.md), [ADR-0005](0005-search-and-embeddings.md),
  [ADR-0008](0008-curation-locality.md), issue #29

## Context

Write-time dedup (the curator, ADR-0007/0008) only sees canon + local staging. Two teammates on
two machines can therefore each capture the same fact and land **near-duplicate canon notes** that
neither's write-time gate could see. Once those notes union-merge together, nothing reconciles
them — the brain accretes duplicates, which erodes trust (the failure mode ADR-0008 warns about).

ADR-0008 pins the contract for fixing this: a periodic **consolidation pass** that is
supersede-not-delete and single-writer, using the pluggable curator/embedder seam (ADR-0005).

## Decision

Add `consolidateCanon(brainDir)` (curate) plus a `commonwealth consolidate` verb:

- **Supersede-not-delete.** A duplicate is marked `status: "superseded"` + `superseded_by:
  <survivor id>` in place — the file is kept, git history and the reconciliation stay visible, and
  the frontmatter change union-merges (additive). Never delete.
- **Single-writer.** The pass acquires the same cross-process sync lock the daemon uses (#100,
  now in `@cmnwlth/core`), so a consolidation can't run concurrently with a sync or another
  consolidation. If the lock is held it no-ops (`skipped`) rather than racing. This satisfies the
  ADR-0008 single-writer requirement without a new lease mechanism.
- **Explicit, not automatic (for now).** It runs on demand (`commonwealth consolidate`, with
  `--dry-run`), not as a silent step inside every sync. Explicit invocation keeps a canon-mutating
  operation auditable and sidesteps "which daemon, how often" until there's a reason to automate.
- **Conservative + deterministic matching.** Only the supersede-able kinds (**memory**,
  **decision** — the only ones with `status`/`superseded_by`), only within a kind, only clusters
  above a high similarity threshold (default 0.9). Similarity is the deterministic token-set
  Jaccard today; the embedder/curator seam (ADR-0005) can replace the metric later without
  changing the control flow. Survivor selection is deterministic: prefer the most recently
  `verified` (memory), then the newest `created`, then the smallest id — so two machines choose
  the same survivor.

## Consequences

- Duplicates collapse to one survivor while every version remains recoverable; readers follow
  `superseded_by`.
- Because it's lock-gated and supersede-only, a bad run is safe and reversible (git + status flag).
- **Deferred:** semantic (embedding-based) matching lands with ADR-0005; automatic/leased
  operation (running inside the daemon on a schedule) is a later step if on-demand proves
  insufficient. Non-supersede-able kinds (work-state, person) are out of scope — they have no
  supersession fields.
