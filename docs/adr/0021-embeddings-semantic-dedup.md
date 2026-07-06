# 21. Embeddings: opt-in local-first semantic dedup, vectors in the derived index

- Status: Accepted
- Date: 2026-07-05 (accepted 2026-07-06)
- Deciders: kristof (owner); Claude (orchestrator, proposer)
- Relates: [ADR-0005](0005-search-and-embeddings.md) (pluggable embeddings later),
  [ADR-0003](0003-concurrency-model.md) (derived index is disposable),
  [ADR-0007](0007-curation-review-gate.md)/[ADR-0008](0008-curation-locality.md) (the gates),
  [ADR-0009](0009-brain-config-feature-flags.md) (feature flags), issue #107

> Fills in the concrete design ADR-0005 deferred. It changes no behavior until the `semanticDedup`
> feature flag is turned on. One refinement was made during implementation (see the note on the
> local provider in decision 2): the local model package is not even an `optionalDependencies`
> entry — it is installed by the team only on enable — so the base install pulls nothing extra at
> all, which is a stronger version of the light-install guarantee than "optional dependency".

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
   - **`local` (the provider default once the flag is on):** a small sentence-embedding model
     (`Xenova/all-MiniLM-L6-v2`, ~384-dim) loaded by **dynamically importing a package that is NOT
     a dependency of Commonwealth at all** — not even `optionalDependencies`. The team installs it
     on the host only when it turns the feature on; absent, `embedProvider` throws an actionable
     "install it or switch provider" error. The base install pulls nothing extra; no note text
     leaves the machine.
   - **`hosted` (opt-in adapter):** an OpenAI-compatible embeddings API (`{ data: [{ embedding }] }`),
     selected only by explicit `embeddings.provider: "hosted"` + `endpoint` config, with the config
     surface stating plainly that note text is sent to that provider. Never a default. No new
     runtime dependency — it uses the platform `fetch`.
   - **`none`:** no embedder; today's lexical-only behavior. The *effective* default is this,
     guaranteed by the `semanticDedup` flag being off (decision 5) — so a fresh brain never loads
     an embedder regardless of the stored `provider` value.

3. **Vectors live in the derived SQLite index — no second datastore.** A `vectors(id, dim, vec)`
   table in the existing gitignored index (ADR-0003/0005): disposable, rebuilt from markdown,
   never a source of truth, never synced. Similarity is **brute-force cosine in JS** — a team brain
   is hundreds–low-thousands of notes, so O(n) per candidate is fine and adds **no native vector
   store** (no sqlite-vec/LanceDB) to maintain or ship.

4. **Gate wiring.** `buildIndex` populates the `vectors` table for all canon notes when the flag is
   on (embedding is best-effort — a misconfigured/absent provider logs and yields a vector-free
   build rather than breaking the rebuild, and hence search/sync). When curating, the gate embeds
   only the **candidate**, cosines it against the stored **canon** vectors, and treats
   `>= threshold` (default **0.85**) as a near-duplicate — feeding the *existing* dedup outcome,
   **augmenting, not replacing** the Jaccard gate (lexical still runs first; either can flag a dup).
   An empty/stale vector set simply no-ops to lexical-only (a missed dup, never a crash — the same
   staleness contract the lexical FTS index already has). Consolidation (ADR-0017) can use the same
   signal for cross-user near-dupes.

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

## Implementation (as shipped)

1. `@cmnwlth/core` (`embed.ts`): `Embedder` interface, pure `cosineSimilarity`, and an
   `embedProvider(config.embeddings)` selector (`none` → null, `local` → dynamic import, `hosted` →
   `fetch` adapter). `index-db.ts` gains a `vectors(id, dim, vec)` table (rebuilt in the same
   single transaction as the FTS table) plus `loadVectors(brainDir)`; `buildIndex(brainDir, { embedder })`
   embeds all notes up front (async, outside the sync transaction) and stores them.
2. `local` provider dynamically imports `@xenova/transformers` (not a declared dependency) with an
   actionable error when absent; `hosted` posts to a config-set endpoint via the platform `fetch`.
3. `@cmnwlth/curate` (`curate.ts`): when `semanticDedup` is on, embed the candidate and reject it as
   a `duplicate` if cosine to any canon vector ≥ `embeddings.threshold`, alongside the Jaccard gate.
   The embedder is injectable (tests) and resolved from config in production; any failure degrades
   to lexical-only.
4. `semanticDedup` feature flag (default off) + an `embeddings` block (`provider`/`threshold`/…) in
   brain config; `commonwealth feature enable semanticDedup` toggles the master switch.
5. Tests: dedup catches a paraphrase the lexical gate misses (with a deterministic stand-in
   embedder, no model download in CI); flag-off path loads no embedder and is unchanged; empty
   vectors no-op rather than false-reject; vectors round-trip and rebuild from markdown; cosine and
   provider-selection correctness.

Contradiction detection remains out of scope (decision 1) — its own follow-up.
