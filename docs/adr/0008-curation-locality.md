# 8. Curation locality: staging is per-user local; only canon syncs

- Status: Accepted
- Date: 2026-07-01
- Deciders: kristof (owner), Claude (orchestrator)
- Relates: [ADR-0003](0003-concurrency-model.md), [ADR-0007](0007-curation-review-gate.md), issues #10, #11

## Context

Curation runs on each user's machine. If the `staging/` review queue were synced (as the
first M3 cut left it — nothing excluded it from git or the sync daemon), multiple users'
curators would share one queue and race on capture/approve/reject. This contradicts the
"design conflicts out" thesis.

Analysis (two independent passes agreed): git history can't be corrupted — staged notes
are atomic files with collision-proof ids and `approve` writes a fresh canonical path, so
everything union-merges (ADR-0003). The real exposures are **semantic**: (a) two machines
capture "the same" learning and both pass a dedupe gate that only sees local state, and
(b) a future consolidation pass that _mutates_ notes could have two daemons touch the same
pair.

## Decision

1. **Staging is per-user local and never synced.** `staging/` is gitignored and ignored
   by the sync daemon's watcher. Capture/review happen privately on each machine.
2. **Only approved canon notes sync.** `approve` writes a new atomic note into the
   canonical folder → conflict-free append (ADR-0003). Concurrent curators therefore only
   ever add new canon notes; they never share mutable review state.
3. **Cross-user semantic duplication is accepted at write time and consolidated later.**
   The write-time dedupe gate only sees canon + local staging; near-dupes from two
   machines land in canon and are reconciled by a periodic **consolidation pass**.
4. **The consolidation pass is supersede-not-delete and single-writer.** It marks a
   duplicate `superseded_by` (additive, union-merges — never delete/delete) rather than
   deleting, and runs as a single writer (lease-gated, or only one designated daemon /
   only on the canonical branch) so two consolidations can't fight. If they ever do touch
   the same file, the write queue (#7) + conflict-as-siblings (#8) already prevent loss.

## Consequences

- No shared mutable curation state → no cross-user curation race by construction.
- Review is private per user (matches ADR-0007's lightweight queue). A shared/team review
  queue, if ever wanted, is an opt-in layer (PR-based, which handles concurrency via
  merge) — not the default.
- The consolidation pass + its embedder-backed semantic dedupe are **future work**
  (post-M3, alongside the ADR-0005 `Embedder`). This ADR pins its concurrency contract so
  it's built single-writer/supersede-only from the start.

## Alternatives considered

- **Synced shared staging** — one team review queue, but reintroduces cross-user races and
  ambiguous ownership of pending items. Rejected as the default.
- **Delete-on-consolidate** — simpler but creates delete/delete and modify/delete races.
  Rejected in favor of supersede-not-delete.
