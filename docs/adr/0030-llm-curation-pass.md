# 30. LLM curation pass completes ADR-0007's deferred curator

- Status: Accepted
- Date: 2026-07-16
- Deciders: kristof (owner)
- Relates: [ADR-0007](0007-curation-review-gate.md) (the deferred curator this completes),
  [ADR-0014](0014-auto-promotion-default.md) (autoPromote — why clean canon matters),
  [ADR-0021](0021-embeddings-semantic-dedup.md) (deferred contradiction detection this delivers),
  [ADR-0025](0025-hybrid-semantic-retrieval.md) (the flag-inert-without-capability discipline),
  [ADR-0027](0027-host-neutral-extraction-runtime.md) (the host runtime this reuses), #237, #214

## Context

ADR-0007 built a deterministic curation gate (relevance floor + token-set dedup) and explicitly
deferred a smarter curator "to an LLM/embedding-backed curator" behind the same seam. ADR-0021 added
semantic dedup and, likewise, explicitly **deferred contradiction detection** ("these two notes
disagree" is harder than "these two say the same thing"). Meanwhile ADR-0014 made autoPromote the
default: captured notes reach canon with no human in the loop. The deterministic gate can catch
restated duplicates, but not trivia a length check misses, not a paraphrased *update* that should
retire its ancestor, and not a *contradiction* of existing canon. So autoPromote canon slowly
accumulates ephemera, stale-next-to-fresh pairs, and silent disagreements — exactly where a brain's
trust should be strongest.

agentcairn's autonomous pipeline is the blueprint: after deterministic gates, a small LLM call
scores durability ("would a teammate acting in 3 months want this?") and classifies each candidate
against its nearest canon as DISTINCT / DUPLICATE / SUPERSEDES / CONTRADICTS. The hard constraint is
safety: a classifier or transport failure must never drop or merge a fact.

## Decision

Add an LLM curation pass to the default capture pipeline, behind a new `llmCurator` feature flag
(default **on**, inert without a host runtime — the ADR-0025 discipline). It has three seams, each
placed where its doctrine already lives:

1. **The classifier runs in the plugin hook layer, not in `@cmnwlth/curate`.** The host-neutral
   extraction runtime (ADR-0027) already owns model invocation, the recursion guard, timeouts, the
   isolated Codex cwd, and schema-constrained output for both claude and codex. The classifier is a
   second consumer of that exact request contract (`invokeHostModel`), so curate's engine stays
   deterministic and offline. Candidates and neighbors are transcript-style DATA in the prompt; the
   classifier never follows instructions from them.

2. **Deterministic, offline neighbor lookup (`curate neighbors`) precedes one batched call.** A new
   model-free curate subcommand returns, per candidate, its top-k nearest CANON notes using the
   existing similarity machinery (stored vectors when present, lexical Jaccard fallback) and reports
   the `llmCurator` flag. The hook then makes **one** batched classifier call for all candidates
   (never per-candidate — latency), annotating each with a verdict.

3. **Curate applies the verdicts deterministically.** The capture input schema gains an optional
   `verdict` per candidate. `trivia` → rejected `llm-trivia` (logged, never staged). `duplicate` →
   rejected `llm-duplicate` with `duplicateOf`. `supersedes` → stage/promote the new note (stamped
   with a `supersedes` link) AND, when it reaches canon, mark the target superseded (`status` +
   `superseded_by`, via the existing `supersedeNote` helper). `contradicts` → stage/promote the new
   note WITH a `contradicts: [targetId]` frontmatter marker and the `contradicted` tag (so `health`
   counts it), surfaced in the receipt and the `pending` queue — **never auto-rejected** (this is
   the #214 deliverable). An absent or malformed verdict is DISTINCT — byte-identical to the
   pre-ADR-0030 gate.

4. **Fail-open is the invariant.** Flag off, no host runtime, timeout (60s hard cap on the batch
   call), non-zero exit, or unparseable output all leave the candidates unannotated → DISTINCT, with
   one stderr breadcrumb. A classifier can only ADD a verdict; it can never drop a candidate. "Never
   cosine alone" holds: only an explicit LLM verdict may drop (duplicate) or merge (supersedes) a
   fact, and a consolidation verdict without a resolvable target degrades to DISTINCT.

5. **Auditability without a new store.** The verdict outcome (superseded / contradiction / trivia /
   duplicate counts) rides back on the `capture` stdout as a sentinel line the hook parses into the
   receipt ("… 1 superseded an older note, 1 flagged as a contradiction, 2 filtered as trivia").
   For `autoPromote: false` brains the `contradicts`/`supersedes` frontmatter surfaces as
   annotations in `pending` — the curator agent's (#198) input. No capture-log (#211) exists on
   `main` yet, so verdicts land in receipts + note frontmatter only for now.

Manual paths are untouched: `/commonwealth:remember` and `curate stage` bypass the judge
(user-intentional notes are durable by definition); consolidation for manual notes is out of scope.
The staging / promote / reject / PR-review machinery is unchanged — the automatic gate got smarter,
the human-capable gate stayed.

## Consequences

- autoPromote canon stays clean without human review: trivia is filtered, paraphrased updates retire
  their ancestor instead of piling up beside it, and contradictions are flagged at write time (the
  `health` contradicted count becomes a real signal, not a latent one).
- A team with the flag on but no host runtime, or a brain that hits any classifier failure, gets
  exactly today's behavior — the feature is safe to ship on by default.
- The ADR-0027 host boundary now serves two consumers (extraction, classification) through one argv
  contract; a new host still needs only an adapter, not a pipeline fork.
- One extra deterministic curate call (`neighbors`) and one batched model call per capture, both in
  the detached SessionEnd/PreCompact worker — off the per-turn hot path.

## Alternatives considered

- **Put the classifier inside `@cmnwlth/curate`.** Rejected: curate is deterministic/offline by
  doctrine and has no model-invocation, recursion-guard, or host-adapter machinery; it would
  duplicate ADR-0027's boundary. Curate applying a verdict it was handed keeps that line clean.
- **Per-candidate classifier calls.** Rejected: latency. One batched call with each candidate's
  neighbors is materially cheaper and lets the model see the batch together.
- **Let cosine similarity alone drop/merge notes.** Rejected outright: a similarity score is a
  *candidate-pairing* signal, never a verdict. Only an LLM (or a human) may drop or merge a fact.
- **Auto-reject contradictions.** Rejected (and the whole point of #214): a contradiction is the
  most valuable thing to surface, not to silently discard. Flag and keep; let a human reconcile.
- **A new feature flag gated OFF by default.** Rejected: matching ADR-0025, "on but inert without
  the capability" ships the value to every runtime-equipped team without a config step, while
  changing nothing for those without one.
