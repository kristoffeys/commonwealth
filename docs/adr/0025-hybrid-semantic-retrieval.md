# 25. Hybrid lexical + semantic retrieval in `search()`, reusing the ADR-0021 vectors

- Status: Accepted
- Date: 2026-07-12
- Deciders: kristof (owner); Claude (orchestrator, proposer)
- Relates: [ADR-0005](0005-search-and-embeddings.md) (pluggable embeddings, retrieval later),
  [ADR-0021](0021-embeddings-semantic-dedup.md) (the `Embedder` seam + per-note `vectors` table this
  reuses), [ADR-0003](0003-concurrency-model.md) (derived index is disposable),
  [ADR-0009](0009-brain-config-feature-flags.md) (feature flags),
  [ADR-0020](0020-ask-the-brain-agent-synthesis.md) ("ask improves for free" as retrieval improves),
  issues #213, #209, #107

> Delivers the semantic *ranking/search* step ADR-0021 explicitly left as "a separate step":
> ADR-0021 shipped the embeddings provider seam and a per-note `vectors` table but used them only in
> the write-time dedup gate. The retrieval engine was built and idle. This ADR wires it into read
> time.

## Context

All retrieval — `ask`, `recall`, the MCP `search` tool, and per-prompt injection — funnels through
core `search()`, which is FTS5-lexical only. FTS5's implicit-AND means a stopword-heavy natural
question (`"did we use shopware before?"`) requires *every* token to be present in one note, so it
returns zero on a brain with 330 notes about Shopware. Paraphrases miss entirely: a note phrased
"Cloud CDN was never purged on deploy" is invisible to "why were the styles stale?".

ADR-0021 already shipped the enabling infrastructure (the `Embedder` seam, `embedProvider`,
`cosineSimilarity`, and a per-note `vectors(id, dim, vec)` table in the derived index) — used only
at capture time. The durable fix is to fuse a semantic ranking into `search()` so every caller
inherits it (#209's OR-fallback stays as the zero-dependency near-term patch; this is the durable
one).

## Decision

1. **Hybrid lives inside `search()`.** No new public search function — `ask`/`recall`/MCP/injection
   all improve for free (ADR-0020). `SearchResult.score` becomes the fusion score when the semantic
   path is active; it stays strictly *ordinal* (higher = better), which is all callers rely on
   (coverage checks `> 0`, never a magnitude; curate/CLI/MCP sort or ignore it).

2. **New feature flag `semanticSearch`, default ON** (ADR-0009). Rationale: `config.embeddings` is
   already an explicit opt-in — an unconfigured brain resolves no provider, so a default-on flag
   changes nothing for it (it degrades to lexical). Teams that configured embeddings for dedup get
   better retrieval for free. Setting the flag `false` forces lexical-only even with a provider.
   Independent of `semanticDedup`: either flag now causes `buildIndex` to populate `vectors`.

3. **Merge = Reciprocal Rank Fusion** (`score = Σ 1/(60 + rank)`, standard k=60) over the BM25 list
   and the cosine list. RRF sidesteps normalizing BM25's and cosine's incomparable scales. After
   fusion, the existing stale-demotion tiering is applied (stale notes rank below fresh regardless),
   matching the lexical `ORDER BY (status = 'stale')`. Ties break by id for determinism.

4. **Filters apply to semantic hits identically.** kind / source / superseded come from the note
   metadata (read from the FTS table); a semantic candidate is dropped by the same rules as a
   lexical one, so a superseded / wrong-kind / wrong-source note can never resurface via its vector.

5. **Graceful degradation is absolute.** No provider resolved / no `vectors` table / empty vectors /
   `embed()` throws or exceeds a hard 3s timeout ⇒ return exactly the lexical result. Never an
   error, never a latency cliff — the query-embed call is wrapped in `Promise.race` with a timeout;
   on timeout the lexical path returns. The resolved provider embedder is cached per process (a
   `local` model warm-up is seconds) so a long-lived host doesn't reload it per search.

6. **Candidate cap.** Take the top ~50 cosine candidates (full scan of the `vectors` map is fine at
   team scale, thousands) and fuse with a comparable slice of the BM25 list.

## Consequences

- **Paraphrase-proof retrieval when a provider is configured**, with zero change for brains that
  aren't. The #213 done-criterion holds: the stopword query retrieves the Shopware note where
  FTS5-AND returned zero, and `ask` coverage stops reporting `matched: false` for paraphrased canon.
- **Score scale changed under the semantic path** (RRF, not negated BM25). Documented on the
  `search()` JSDoc; verified no caller does arithmetic on the magnitude.
- **Backfill:** vectors exist only for notes indexed while a semantic feature was on with a working
  provider. Existing brains need one `buildIndex` rebuild (e.g. via the next sync, `remember`, or an
  explicit reindex) to backfill vectors for pre-existing notes before semantic hits appear.
- **No new dependency or datastore** — reuses ADR-0021's `vectors` table and brute-force cosine.

## Alternatives considered

- **A new `semanticSearch()` function callers opt into.** Rejected: every caller would have to be
  re-wired and could drift; putting it in `search()` is the ADR-0020 "improves for free" contract.
- **Weighted-sum fusion of normalized BM25 + cosine.** Rejected: the two scores live on
  incomparable, distribution-dependent scales; per-query normalization is fragile. RRF is
  rank-based, tuning-free, and the standard hybrid-search choice.
- **Default the flag OFF.** Rejected: it would leave the idle engine idle for teams who already
  opted into embeddings; default-on is inert for unconfigured brains (decision 2) so the risk is nil.
- **Embed-and-rank synchronously with no timeout.** Rejected: a slow/hanging local model would turn
  every search into a latency cliff; the hard timeout keeps the lexical guarantee.

## Implementation (as shipped)

1. `@cmnwlth/core` `config.ts`: `semanticSearch` feature flag (default true). `index-db.ts`:
   `computeVectors` widened to populate `vectors` when `semanticDedup OR semanticSearch` resolves a
   provider; the "embedder unavailable" build warning is deduped once per process (default-on would
   otherwise log on every rebuild for brains without the local model).
2. `search()` resolves the query embedder (injectable via `SearchOptions.embedder`, mirroring
   `buildIndex`: `null` forces lexical, an explicit `Embedder` bypasses config, `undefined` resolves
   from config iff the flag is on — cached per process). It embeds the query under a 3s
   `Promise.race` timeout (`SearchOptions.embedTimeoutMs` override for tests), cosine-ranks the
   `vectors`, filters by the same metadata as the lexical list, RRF-fuses, applies stale demotion,
   and caps at `limit`. Every degradation path returns the untouched lexical result.
3. Tests: the #213 stopword/paraphrase query retrieves a semantically-near note where FTS5-AND is
   empty; lexical-only (null / no provider) is byte-identical to before; superseded/kind/source
   filters exclude semantic hits; embed-throws and embed-hangs both fall back to lexical with no
   rejection; RRF ranks a both-lists note above single-list hits with stale still demoted;
   `buildIndex` populates vectors under a semanticSearch-only config; `ask` coverage reports
   `matched: true` when only a semantic hit exists.
