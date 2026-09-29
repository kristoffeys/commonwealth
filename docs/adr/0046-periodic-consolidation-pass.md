# 46. Periodic consolidation pass: `consolidate` moves from explicit-only to gated-automatic

- Status: Accepted
- Date: 2026-09-29
- Deciders: kristof (owner), Claude (orchestrator)
- Supersedes: [ADR-0017](0017-canon-consolidation-pass.md) §"Explicit, not automatic (for now)" —
  everything else in ADR-0017 (supersede-not-delete, single-writer lock, conservative deterministic
  matching) is unchanged and reused as-is
- Relates: [ADR-0003](0003-concurrency-model.md) (supersede-not-delete, union-merge), [ADR-0007](0007-curation-review-gate.md)
  / [ADR-0014](0014-auto-promotion-default.md) (`autoPromote` — the review-gate interaction),
  [ADR-0030](0030-llm-curation-pass.md) (the classifier/neighbors machinery this reuses, not
  duplicates), [ADR-0032](0032-daemonless-lifecycle-sync.md) (the lifecycle-hook trigger model this
  copies), [ADR-0039](0039-capture-receipts.md) (never-silent receipts), #273 (quiet-tick
  checkpoints), #319

> The gate shape (time + session-count, single lock, background worker) is adapted from Claude
> Code's built-in `autoDream` — idea only, no code or prose reused. `autoDream` tends personal
> memory; this ADR applies the same gating discipline to a **team's shared, git-backed canon**,
> which is why the safety posture (never delete, respect `autoPromote`, single-writer lock) is
> stricter throughout.

## Context

ADR-0017 shipped `consolidateCanon()`: supersede-not-delete, single-writer (the same cross-process
sync lock the daemon uses), conservative token-set-Jaccard matching at a 0.9 threshold, restricted
to the supersede-able kinds (`memory`, `decision`). It deliberately stayed **explicit, not
automatic** — a human runs `commonwealth consolidate [--dry-run]` — "until there's a reason to
automate." #273 later added quiet-tick checkpoints so a scheduled run over an unchanged brain is a
cheap no-op instead of a repeated O(n²) scan, which was explicitly framed as prep for exactly this.

Nothing runs it, though. A team's canon still only de-duplicates when someone remembers to type the
command. Meanwhile ADR-0030 already gave capture a smarter judge (durability + DISTINCT / DUPLICATE
/ SUPERSEDES / CONTRADICTS) for *newly captured* candidates against their nearest canon neighbor —
but that judge never revisits canon-to-canon pairs that landed before it existed, or two notes each
written independently that the write-time gate couldn't see together (the exact cross-user race
ADR-0017 exists to clean up after the fact).

Claude Code's `autoDream` is the reference shape for "periodic, low-stakes background tidying done
right": gated to at most once per 24h **and** ≥5 sessions since the last run (so it can't fire
back-to-back and can't fire on a burst of trivial sessions), taking a lock, running in a background
agent that re-reads state and merges/reconciles it. #319 asks for our version of that discipline
applied to `consolidateCanon`.

## Decision

**Wire the existing `consolidateCanon` into the SessionEnd lifecycle, gated like `autoDream`, with
the `autoPromote` flag deciding whether it mutates canon or only reports a plan.** No new merge
engine, no new classifier, no free-roaming agent — the gate is new; the pass it triggers already
shipped in ADR-0017.

1. **Trigger: gated, detached, per-brain, in `packages/curate`.** A new `maybeConsolidate(brainDir,
   opts)` (colocated in `consolidate.ts`, next to the function it calls) is invoked from the
   already-detached SessionEnd worker (ADR-0032's capture worker), right after the sync step — off
   the per-turn hot path, matching where `consolidateCanon`'s sibling maintenance pass
   (`graduate`) already expects to run. It is NOT wired into SessionStart: SessionStart is
   latency-budgeted (5s hard cap, ADR-0032) and consolidation's cost, even quiet-tick-shortened, has
   no place in that budget.

2. **Gate: time AND session count, tracked in derived per-brain state.** A small file,
   `index/consolidate-gate.json` (same `index/` area as checkpoints and receipts — derived,
   disposable, gitignored, never synced), holds `{ sessionsSinceCheck, lastCheckedAt }`. Every
   qualifying SessionEnd increments `sessionsSinceCheck`; the pass is due only when
   `sessionsSinceCheck >= 5` **and** (`lastCheckedAt` is absent, or `now - lastCheckedAt >= 24h`).
   Both defaults match `autoDream`'s numbers; both are options on `maybeConsolidate`, not new config
   flags — nobody has asked to tune them yet, and a brain-level flag for a rate limit nobody has
   complained about would be premature.

   The gate advances (`sessionsSinceCheck` resets to 0, `lastCheckedAt` refreshes) on every
   **attempt**, whether or not `consolidateCanon` finds anything to do — this mirrors
   `consolidateCanon`'s OWN quiet-tick checkpoint semantics (`confirmCheckpoint` advances on a
   no-op tick too, #273): the gate answers "did we check recently enough", not "did we find
   something", so a quiet brain doesn't re-scan every qualifying session forever.

3. **Single-writer, reused verbatim.** `maybeConsolidate` calls `consolidateCanon`, which already
   takes the cross-process sync lock and returns `{ skipped: "another writer holds the sync lock" }`
   rather than blocking or racing (ADR-0017). The periodic trigger changes nothing here — lock
   contention is a **skip**, exactly like every other lifecycle-sync collision (ADR-0032 §4).

4. **`autoPromote` decides mutate-vs-report, not run-vs-skip.** The gate still fires on schedule
   either way (a `false` `autoPromote` team still wants to know duplicates are piling up), but what
   happens with what it finds differs:
   - `autoPromote: true` (default posture, ADR-0014): `consolidateCanon` runs for real — the
     existing supersede-not-delete write path, unchanged.
   - `autoPromote: false`: `consolidateCanon` runs with `{ dryRun: true }` — it computes the exact
     same clusters/survivors but writes nothing. When it finds ≥1 cluster, that is surfaced as a
     **pending review** item via the existing one-shot SessionEnd receipt (the same "next
     SessionStart shows this" channel capture/sync outcomes already use — see
     `endReceiptMessage`/`renderCaptureReceipt` in `packages/plugin/hooks/lib.mjs`), naming the count
     and pointing at `commonwealth consolidate` (or the curator agent, which already recommends this
     exact command) to apply it. This is the "routes to staging" requirement translated into this
     pass's actual shape: consolidation doesn't create new notes to hold in `staging/`, it proposes
     mutating existing ones, so the review artifact is the existing dry-run preview plus a receipt
     that makes it impossible to miss — not a new staging file format.

5. **Scope, unchanged from ADR-0017.** Only `memory`/`decision` kinds, only same-kind clusters,
   only the existing 0.9 lexical-Jaccard threshold. **Decisions are supersede-only, never
   silently rewritten**: a `decision` note can be marked `superseded_by` (a newer decision replaced
   it — exactly ADR-0017's existing behavior) but the periodic pass never edits a decision's body or
   auto-merges its rationale away, matching the instruction that decisions are never
   auto-rewritten.

6. **Contradiction detection between existing canon pairs and relative-date normalization are
   explicitly deferred (see "Deliberately not done").** The ticket's `autoDream` reference does
   both; this ADR ships neither, to keep the diff to "wire an existing, already-reviewed engine
   into a gate" rather than "design a second classifier pass."

7. **Fail-open, always.** `maybeConsolidate` never throws out of the SessionEnd worker: gate-state
   read/write failures collapse to "not due" (skip, don't guess), and any `consolidateCanon` failure
   is caught and dropped exactly like every other best-effort step in that worker (`refreshStatus`,
   `recordCapture`). A broken gate file costs one extra/one fewer scheduled run, never a broken
   session and never a note.

## Consequences

- Canon that accretes near-duplicates from two teammates' independent captures (the exact failure
  ADR-0017 was written to fix) now cleans itself up without anyone remembering to run a command —
  bounded to at most once per 24h and never before 5 sessions have passed, so it can't thrash a busy
  brain or fire on a single trivial session.
- `autoPromote: false` teams get the same schedule but never an automatic canon mutation — the pass
  degrades to "tell me what it would do," consistent with that flag's existing meaning everywhere
  else in the codebase.
- No new merge/classifier code is added; the entire new diff is the gate (state file + due-check),
  the SessionEnd wire-up, and the receipt clause. `consolidateCanon` itself is untouched, so its
  existing test suite still describes exactly what a pass does.
- The lock-contention and quiet-tick behaviors this depends on were already tested (ADR-0017, #273);
  this ADR only needs new tests for the gate's own arithmetic and the SessionEnd wiring's fail-open
  posture.

## Deliberately not done

- **No canon-vs-canon contradiction sweep.** ADR-0030's classifier already flags `contradicts` for
  a *freshly captured* candidate against its nearest neighbor; a periodic sweep that reruns the
  classifier over *existing* canon pairs is a real feature (needs a lower-than-0.9 "worth asking
  the model about" band, a way to annotate an already-canon note with `contradicts`/`contradicted`
  outside the capture path, and a fresh set of prompt/test surface) — big enough to be its own ADR
  once #319's gating lands and the team has a sense of whether cross-user contradictions actually
  occur often enough to justify it. Filed as a follow-up rather than guessed at here.
- **No relative-date normalization.** Every note's `created`/`verified` timestamps are already
  absolute ISO 8601 in frontmatter (`packages/core/src/schema.ts`) — there is no "3 days ago" to
  convert in the data this pass reads. A body that prose-narrates a relative date ("last Tuesday we
  decided...") is a body-text rewrite, which is a much larger and riskier surface (silently editing
  a note's substance is exactly what CLAUDE.md principle 3 warns against) for a problem this
  codebase doesn't actually have today.
- **No new feature flag.** `autoConsolidate` is added to the existing `FEATURE_FLAGS` registry
  (`packages/core/src/config.ts`) — that part isn't new — but the 24h/5-session numbers themselves
  are NOT brain-config-tunable in v1; they're `maybeConsolidate` options with `autoDream`-matching
  defaults. Add config knobs when a team actually asks to tune them.
- **No LLM in this pass.** The periodic trigger calls the same deterministic
  `consolidateCanon` ADR-0017 shipped; it does not invoke the ADR-0027 host runtime at all. Adding
  an LLM step here is exactly the deferred contradiction-sweep work above, gated behind its own
  decision.

## Alternatives considered

- **`autoConsolidate` flag gates run-vs-skip; `autoPromote` is ignored.** Rejected: `autoPromote`
  already means "this brain's owner wants a human in the loop before canon changes," and a second,
  unrelated flag for the exact same posture would be confusing and easy to configure
  inconsistently. Reusing `autoPromote` for mutate-vs-report keeps one flag meaning one thing.
- **Run the gate check on SessionStart instead of SessionEnd.** Rejected: SessionStart already
  carries a tight 5s sync budget (ADR-0032) that consolidation — even quiet-tick-shortened —
  doesn't belong in; SessionEnd already runs in a detached, unbudgeted worker for exactly this
  class of background maintenance.
- **Add a new `staging/consolidation-plan.json` format for `autoPromote: false`.** Rejected: it
  would be a second review-queue shape alongside the existing note-staging one, for a feature that
  already has a perfectly good preview (`commonwealth consolidate --dry-run`, which the curator
  agent already recommends). A receipt pointing at that command is simpler and cannot drift from
  what the command actually reports, since dry-run IS the plan.
- **Store the gate state on the checkpoint file `consolidateCanon` already writes
  (`index/checkpoints/consolidate.json`).** Rejected: that checkpoint's `ranAt` only advances when
  the FULL pass actually runs over a changed tree (ADR #273's `recordCheckpoint`, called only on
  the non-quiet-tick path); a brain that has been quiet for weeks would then never re-arm the
  24h/5-session gate, because "ran" and "checked" are different events. A separate, small gate file
  keeps "how often do we bother checking" independent of "did the last check find work to do."
