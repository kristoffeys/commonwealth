# 21. Embeddings: opt-in local-first semantic dedup, vectors in the derived index

- Status: Proposed
- Date: 2026-07-05
- Deciders: kristof (owner) — _pending acceptance_; Claude (orchestrator, proposer)
- Relates: [ADR-0005](0005-search-and-embeddings.md) (pluggable embeddings later),
  [ADR-0003](0003-concurrency-model.md) (derived index is disposable),
  [ADR-0007](0007-curation-review-gate.md)/[ADR-0008](0008-curation-locality.md) (the gates),
  [ADR-0009](0009-brain-config-feature-flags.md) (feature flags), issue #107

> Proposal for the owner to accept or amend. It fills in the concrete design ADR-0005 deferred; it
> changes no behavior until the feature flag is turned on.

## Context

Write-time dedup today is **lexical** — Jaccard token overlap (ADR-0007/0008) — so it misses
near-duplicates phrased differently ("auth uses JWT" vs "we authenticate with bearer tokens") and
can't see contradictions at all. ADR-0005 already decided the *shape* of the fix — "embeddings
behind a pluggable `Embedder`, **local-first default**, hosted as an opt-in adapter, index stays
disposable" — but left the concrete backend, storage, and gate wiring open. #107 asks for
"embeddings-backed semantic dedup & contradiction detection."

The genuine fork is **dependency weight**: a real local embedding model (e.g. a MiniLM via
transformers.js/onnxruntime) is ~a hundred MB of model + a native-ish runtime. Commonwealth's base
install is deliberately light and fully offline (ADR-0005). We must not make every user pay that
cost — nor send their brain to a hosted API by default (the ownership thesis).

## Decision (proposed)

1. **Scope now: semantic _dedup_. Defer contradiction detection.** Cosine similarity is a solid,
   low-false-positive signal for "these two notes say the same thing." Contradiction ("these two
   _disagree_") is a much harder, higher-false-positive judgement that cosine alone can't make —
   shipping it risks mislabeling notes `contradicted`. It gets its own follow-up (likely an
   agent/LLM judgement over high-similarity pairs, reusing ADR-0020's "the agent judges" pattern),
   tracked separately. #107 lands as semantic dedup; contradiction is explicitly out of this ADR.

2. **`Embedder` interface + config-selected provider.** `embed(texts: string[]) =>
   Promise<Float32Array[]>`. Providers:
   - **`local` (recommended default when enabled):** a small sentence-embedding model loaded via an
     **optional dependency** — declared `optionalDependencies` / dynamically imported, so it is
     installed and downloaded **only when the feature is enabled**. The base install stays light and
     offline; no note text leaves the machine.
   - **`hosted` (opt-in adapter):** a hosted embeddings API, selected only by explicit config, with
     the config surface stating plainly that note text is sent to that provider. Never a default.
   - **`none` (the default):** no embedder; today's lexical-only behavior, unchanged.

3. **Vectors live in the derived SQLite index — no second datastore.** A `vectors(id, dim, vec)`
   table in the existing gitignored index (ADR-0003/0005): disposable, rebuilt from markdown,
   never a source of truth, never synced. Similarity is **brute-force cosine in JS** — a team brain
   is hundreds–low-thousands of notes, so O(n) per candidate is fine and adds **no native vector
   store** (no sqlite-vec/LanceDB) to maintain or ship.

4. **Gate wiring.** When enabled, curation embeds the candidate, finds the nearest **canon** note by
   cosine, and treats `>= threshold` as a near-duplicate — feeding the *existing* dedup outcome
   (skip / supersede), **augmenting, not replacing** the Jaccard gate (lexical still runs; either
   can flag a dup). Consolidation (ADR-0017) can use the same signal for cross-user near-dupes.

5. **Off by default, via a feature flag** (`semanticDedup`, ADR-0009). Flag off ⇒ no embedder is
   loaded, no model downloaded, behavior byte-identical to today. This is the ADR-0005 "local-first,
   no mandatory external service" guarantee made concrete.

## Consequences

- **Base install and offline guarantee are unchanged** — embedding deps are optional and only pulled
  when a team opts in. Privacy is preserved by default (no hosted calls; local stays on-machine).
- **When enabled**, dedup catches paraphrases the lexical gate misses, and the stored vectors are a
  foundation semantic *search*/ranking can later build on (that ranking is a separate step; this ADR
  only wires the dedup gate).
- **Costs land only on opt-in:** first-run model download + cold-start latency (local), or API
  cost + third-party exposure (hosted, explicitly chosen). Cosine is O(n)·dim per candidate — fine
  at team scale; if a brain ever outgrows brute force, an ANN index is a drop-in behind the same
  seam.
- **Rebuild story holds:** vectors regenerate from the notes like the rest of the index; deleting
  `index/` and re-running is always safe.

## Alternatives considered

- **Hosted embeddings as the default.** Rejected by ADR-0005 and again here: mandatory external
  dependency + cost + sending your brain off-machine to read it. Opt-in only.
- **Bundle the local model in the base install.** Rejected: forces ~100 MB + a runtime on every
  user for a feature many won't enable. Optional dependency + lazy load instead.
- **A native vector store now (sqlite-vec / LanceDB).** Rejected as premature (ADR-0005 said the
  same): brute-force cosine covers team scale with zero native deps; revisit only if scale demands.
- **Ship contradiction detection in this ADR.** Rejected: cosine can't reliably tell disagreement
  from similarity; high false-positive `contradicted` tags would erode trust. Separate follow-up.

## Implementation sketch (non-binding, if accepted)

1. `@cmnwlth/core`: `Embedder` interface + a `none` no-op; a `vectors` table in the index schema
   with cosine helpers; an `embedProvider(config)` selector.
2. Optional `local` provider package/module (dynamic import of the model lib) behind
   `optionalDependencies`; `hosted` provider behind config.
3. `@cmnwlth/curate`: when `semanticDedup` is on, add the cosine-nearest-canon check alongside the
   Jaccard dedup in the curation gate + consolidation.
4. `semanticDedup` feature flag (default off) in brain config; `commonwealth config` toggles it.
5. Tests: dedup catches a paraphrase the lexical gate misses; flag-off path loads no embedder and is
   unchanged; vectors rebuild from markdown; cosine correctness.
