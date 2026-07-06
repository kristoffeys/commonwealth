# 22. Decisions are captured by default: `autoAdr` on + an explicit `/commonwealth:decide`

- Status: Accepted
- Date: 2026-07-06
- Deciders: kristof (owner); Claude (orchestrator)
- Relates: [ADR-0009](0009-brain-config-feature-flags.md) (feature flags),
  [ADR-0007](0007-curation-review-gate.md) (curation/review gate),
  [ADR-0014](0014-auto-promotion-default.md) (auto-promote default), issue #33

## Context

A team's shared brain should carry a durable trace of **what was decided, when, by whom, and why**
— the highest-value knowledge a team accumulates. The `decision` note kind already models this
(`title`, `created`, `author`/`deciders`, body for the rationale, `status` proposed/accepted/
superseded, and supersede links). Two things kept it from being reliable:

1. **`autoAdr` defaulted off (ADR-0009).** Decision candidates — whether auto-detected from a
   session or staged explicitly — were dropped at the curation gate unless a team opted in. The
   safe-by-default posture for a noisy *automatic* feature left most brains with **no** decision
   trail at all.
2. **No deliberate path.** Decisions made outside a captured coding session (a business call, an
   assumption being locked in) had no first-class way in, and the generic `stage`/`remember` paths
   couldn't record the structured **who** (`deciders`) or the decision **status**.

## Decision

1. **`autoAdr` defaults ON.** A fresh brain records decision notes out of the box. The flag's
   meaning is broadened accordingly: it governs whether decision notes land in this brain **at
   all** — auto-detected *and* explicitly logged. Set it `false` to opt a brain out of decision
   tracking entirely. Curation gating (dedup, secret, relevance) and the `autoPromote` review
   posture (ADR-0014) are unchanged and still apply.

2. **Add `/commonwealth:decide`** — a deliberate, guaranteed path to log a decision, prompting for
   a clear title, the rationale/assumptions (the *why*, in the body), and the deciders (the
   *who*); *when* is stamped automatically. It records a `decision` note through the same curation
   gate and review queue as everything else.

3. **`commonwealth-curate stage` gains `--deciders` and `--status`** (stored as schema-validated
   kind-specific `fields`), so the deciders and lifecycle status are captured as structured
   frontmatter rather than buried in prose. `/commonwealth:decide` drives these.

## Consequences

- Every brain keeps a decision trail by default; the provenance (who/when/status) is structured and
  queryable, with the rationale in the body. Superseding (not deleting) keeps reversals and their
  reasoning visible (ADR-0003).
- `autoAdr` now gates the explicit `/decide` path too: turning it off suppresses **all** decision
  notes, not just auto-detected ones. This is the intended, simple one-switch model ("this brain
  does / does not track decisions"); it is called out in the flag's description and the README.
- Auto-detection is still best-effort (an LLM extractor judges what's a decision), so the default
  is "captured when detected," not "every decision is guaranteed to be detected." `/decide` is the
  guaranteed path when it matters.
- Existing brains with `autoAdr` explicitly set keep their setting (config values win over
  defaults); only brains that never set it — and newly scaffolded ones — get the on default.

## Alternatives considered

- **Keep `autoAdr` off; rely only on `/decide`.** Rejected: most decisions surface in normal
  sessions; leaving auto-capture off by default means the trail is empty unless someone remembers
  to run a command. The whole point is a trace that accrues without discipline.
- **Decouple `/decide` from `autoAdr` (explicit always records, flag gates only auto).** Considered
  and rejected for now as more surface than it's worth: the explicit paths (`stage`, MCP
  `remember`, `/decide`) and the auto path share one curation entry point, so a clean split would
  mean threading an "explicit" signal through it. The single-switch model is simpler to reason
  about, and with the default on the distinction rarely bites. Revisit if a team wants auto-capture
  off but explicit decisions on.
- **A separate `traceDecisions` flag distinct from `autoAdr`.** Rejected as redundant — one flag
  with a clear, broadened meaning beats two overlapping ones.
