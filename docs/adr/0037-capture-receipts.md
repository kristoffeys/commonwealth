# 37. Capture receipts: every dropped candidate leaves a structured, persisted trace

- Status: Accepted
- Date: 2026-09-02
- Deciders: kristof (owner); Claude (orchestrator, proposer)
- Relates: [ADR-0003](0003-concurrency-model.md) (derived files are disposable and regenerated — the
  invariant receipts live inside), [ADR-0007](0007-curation-review-gate.md) (the gate whose vetoes
  these describe), [ADR-0009](0009-brain-config-feature-flags.md) / [ADR-0022](0022-decisions-captured-by-default.md)
  (the `autoAdr` flag whose veto #266 is about), [ADR-0021](0021-embeddings-semantic-dedup.md) and
  [ADR-0030](0030-llm-curation-pass.md) (the semantic and classifier drop paths), #266, #263, #259

> The mechanism is an idea harvested from [openhuman](https://github.com/tinyhumansai/openhuman)
> (GPL-3.0 — idea only, no code, names, or prose reused): persist structured failure metadata on
> every settled turn — a stable class, whether it is recoverable, a plain-language cause, and a
> concrete next action — so a run can still explain itself long after the process that produced it
> exited. Commonwealth's version is written from that description in Commonwealth's own vocabulary.

## Context

Curation is *gated* and that is correct: the scope, secret, relevance, dedup, `autoAdr`, and
classifier gates all exist to keep canon worth trusting. CLAUDE.md principle 4 draws the line
precisely — a veto is a normal outcome, **never silently dropping** is the requirement. We were
failing the second half.

`RejectedCandidate` carried `reason: string` — free text — on a `CurateResult` that the detached
SessionEnd worker printed to stderr and then threw away when it exited. Consequences:

- **Nothing could aggregate.** "3 candidates dropped as duplicates, 1 secret-blocked, 2
  autoAdr-vetoed" is a diagnosis; three unrelated strings on a vanished stderr are not.
- **Nothing could explain or act.** A reason string says a gate fired. It does not say whether the
  user could have changed the outcome, or how.
- **Nothing survived the process.** By the time anyone asked "why is my brain empty?", the answer
  was gone.

This is our single most recurring fragility class, not a one-off. #266 is the `autoAdr: false`
instance — every decision candidate vetoed, no trace anywhere, `doctor` reporting a clean bill of
health. #263 (a schema draft rejected by the hook layer) and #259 (a detached worker inheriting the
wrong cwd) were the same shape, and each cost real debugging time before anyone thought to look at
the gate.

The capture log (#211) and coverage rollup (#235) already answer the *session-level* question — did
capture run, did it fail, is it healthy over time. They cannot answer the *candidate-level* one:
capture ran fine, extracted six candidates, and saved none. That gap is what a receipt fills.

## Decision

**Every candidate-level drop mints a structured receipt, and the receipt is persisted.**

1. **The drop reason becomes a type, not a string.** `DropClassification` carries a stable machine
   `category` (one enumerated value per drop path that exists in the code today), a `recoverable`
   flag, a plain-language `cause`, and a concrete `nextAction`. The free-text `reason` stays
   verbatim on `RejectedCandidate` — existing readers (the stderr breadcrumbs, the `llm-duplicate`
   tally, the MCP `remember` result) are untouched — and `drop` is added beside it. The categories
   are: `secret-detected`, `autoadr-vetoed`, `too-thin`, `duplicate-lexical`, `duplicate-semantic`,
   `duplicate-llm`, `trivia`, `invalid`, and `unknown`.

   `drop` is a **required** field, deliberately. Optional would have been the additive-safe choice;
   required is the fail-loud one — it makes the compiler, not a reviewer, the thing that stops a new
   gate from shipping without saying what its veto means. `unknown` exists for the same reason: the
   ADR-0007 curator seam is pluggable, so a custom curator's unrecognized reason is classified as
   unclassified and *still counted*, rather than falling out of the tally.

2. **`recoverable` is the loud/quiet split.** A duplicate or a trivia filter is the gate working as
   designed; nagging about it would train users to ignore the surface. A pasted credential, a
   one-line body, or an `autoAdr` veto is almost certainly not what the user intended, so those
   warn and carry the fix. This is what lets receipts be on by default without becoming noise.

3. **Receipts persist under the brain's derived `index/`,** as `index/receipts.jsonl` — deliberately
   *not* notes, and deliberately not a per-user file. Not notes: a receipt is about a candidate that
   never became a note, so writing it into canon would put non-facts in the substrate and hand the
   dedup gate its own rejections to dedup against. Not per-user: drops are per-brain, and `index/`
   is already gitignored in every brain, already ignored by the sync daemon's watcher, and already
   excluded from doctor's sync-debt accounting — so the location makes "never committed, never
   synced, never a second source of truth" structural rather than a rule someone has to remember.

4. **Concurrency is designed out, not resolved** (ADR-0003). Every session's capture worker appends
   to the same file, so a batch is written with a **single `O_APPEND` write**: POSIX makes that
   atomic against other appenders, so workers interleave whole batches, never bytes. There is no
   read-modify-write on the append path and therefore nothing to merge. Growth is bounded by a
   rolling window (200 receipts, trimmed at a 400-line high-water mark so the common append does no
   rewrite at all). A trim is a read-then-atomic-rename, and two workers trimming at once can lose
   one of them a whole batch (measured, not theorized). That is accepted: it needs a full log *and*
   simultaneous writers to happen at all, it costs a diagnostic rather than a fact, and paying for a
   lock on the capture path to protect a diagnostic would be the wrong trade.

5. **Writing a receipt can never cost a note.** The write runs after everything that touches canon,
   and every IO failure is swallowed. Losing a receipt is a worse day; losing a note is a worse
   product.

6. **A receipt withholds any title the secret scanner flags.** The title is the only candidate text
   a receipt persists, and a title is as good a hiding place for a credential as a body. The
   redaction is keyed on the *scanner*, not on the `secret-detected` category: the ADR-0030
   classifier drops (`trivia`, `llm-duplicate`) are rejected before `curate()` scans anything, so a
   category-keyed rule would have written those titles to disk in the clear — the exact failure the
   receipt exists to report on. The scan uses the *brain's own* scanner settings, not the defaults,
   so a team that opted into entropy detection (#46) gets that stricter scan here too. The category,
   count, and fix survive; the text does not.

7. **The surfacing is aggregate.** `commonwealth doctor` gains two links: a **Decisions** link
   emitted only when `autoAdr` vetoed decision candidates — #266 verbatim: say it happened, say how
   many, say how to change it — and a **Drops** link rolling up everything else, `ok` when only
   correct-by-design classes fired and `warn` with the next action when a recoverable one did.
   `commonwealth status` prints the same rollup as one line beneath the last-capture line.

Manual paths (`/commonwealth:remember`, `curate stage`) are unchanged: the user is standing there
when the gate fires and gets the rejection synchronously, so there is nothing for a receipt to
outlive. Note frontmatter is untouched — receipts are about candidates that never became notes.

## Consequences

- **A veto stops being invisible.** "Capture ran and saved nothing" now has an answer that survives
  the worker, is countable, and names the fix. #266's specific complaint is a one-line `doctor`
  warning.
- **Findings age out on their own.** `doctor` and `status` read only a trailing 7-day window, and
  the `autoAdr` warning is cross-referenced against the live flag rather than asserted from history
  — so acting on the fix clears the finding. A surface that kept warning after the user fixed the
  cause would be a different way of lying about the same thing.
- **Receipts legitimately vanish**, and we say so rather than pretending otherwise. A fresh clone
  has none; `rm -rf index/` wipes them; so does any rebuild of the derived layer. Unlike the search
  index they cannot be *regenerated* — they describe candidates that were never written down
  anywhere. That is the honest cost of keeping them out of git, and the right one: a diagnostic that
  survived into the substrate would be a second source of truth, which ADR-0003 forbids outright.
  The rolling window means they also age out of their own accord.
- **Adding a gate now costs one table entry.** The required `drop` field and the single
  cause/next-action table mean a new drop path cannot be added without deciding what it means to a
  user — which is the durable fix for the fragility class, more than any individual receipt is.
- **One more small write per capture,** in the detached worker, off the per-turn hot path.

## Alternatives considered

- **Keep the free-text `reason`, just log it harder.** Rejected: this is what we had. A string on a
  stream nobody reads cannot be aggregated, cannot say whether the user can act, and does not
  outlive the process. The persistence and the typing are the whole point.
- **Write receipts as notes in canon.** Rejected: they are records of things that are *not* facts
  about the team. They would pollute recall, feed the dedup gate its own rejections, and make the
  brain grow fastest exactly when it is capturing least.
- **Reuse the per-user capture log (`~/.commonwealth/capture.log`).** Rejected: drops are per-brain,
  and the capture log already answers a different question (session-level outcomes and coverage
  trends). Filtering per-brain candidate drops out of a per-user session log would blur two
  measurements that are useful precisely because they are separate.
- **A `receipts` table in the SQLite index.** Rejected: the index is rebuilt from canon and receipts
  cannot be, so they would be the one thing in there a rebuild silently destroyed — a sharper edge
  than a plain JSONL file, for no gain at this size.
- **Lock the receipt file per write.** Rejected: a single append is already atomic, and a lock on
  the capture path to protect a disposable diagnostic inverts the priorities.
- **Warn on every drop.** Rejected: duplicates and trivia are the gate succeeding. A surface that
  cries wolf on correct behavior is one users learn to skip, which would recreate the silence this
  ADR exists to end.

## Deliberately not done

- **No new config flag.** Receipts are always on; there is no world where a team wants their drops
  to be silent again.
- **No receipt for the scope gate.** An out-of-scope cwd (ADR-0024) declines the whole session
  before any candidate exists — a session-level outcome the capture log already records as
  `skipped`. Giving it a candidate category would have been a guess at a gate that does not work
  that way.
- **No retry / replay.** A receipt says what to do; it does not do it. Re-capturing a dropped
  candidate needs the candidate text, which is exactly what a receipt refuses to persist.
- **No org-brain or graduation receipts.** `graduate` runs its own `curate()` pass; it is an
  interactive, operator-invoked command rather than a detached worker, so there is no vanished
  process for a receipt to outlive. Its gate rejections are only counted on stderr today, and its
  `autoAdr` filter drops decisions before a `RejectedCandidate` even exists — a real instance of
  this same problem, left for a follow-up rather than widened into this change.
