# 5. Search: SQLite FTS5 now, pluggable embeddings later

- Status: Accepted
- Date: 2026-07-01
- Deciders: kristof (owner), Claude (orchestrator)
- Relates: GitHub issue #24

## Context

The derived index powers `search`. We must decide whether to build on embeddings
(semantic) from day one, and if so local vs hosted — the ownership thesis pulls toward
local/offline, while hosted embeddings are easier and often better.

## Decision

- **Phase 1 (M0/M1): lexical search via SQLite FTS5** over titles, body, tags, and
  frontmatter. No embeddings, no external calls, fully offline.
- **Embeddings are introduced behind a pluggable `Embedder` interface** when semantic
  recall is needed (M3 relevance gating / curation). Default implementation is
  **local-first** (a local model or none); a hosted embedder is an opt-in adapter.
- The index remains **disposable and rebuildable** from the markdown regardless of
  backend.

## Consequences

- Unblocks M0/M1 without embedding infrastructure; search works offline on day one.
- Keeps the ownership guarantee (no mandatory external service to read your own brain).
- Semantic quality is deferred; FTS5 + tag/entity filters are enough for early dogfood.
- The `Embedder` seam must be defined early so M3 can slot semantic ranking in without a
  rewrite.

## Alternatives considered

- **Hosted embeddings from day one** — easier/better recall, but adds a mandatory
  external dependency and cost to reading your own data. Rejected as the default.
- **Local vector DB now (LanceDB/sqlite-vec)** — premature; FTS5 covers v1 and avoids a
  second store before we need it.
