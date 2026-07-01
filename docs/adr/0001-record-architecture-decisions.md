# 1. Record architecture decisions

- Status: Accepted
- Date: 2026-07-01
- Deciders: kristof (owner), Claude (orchestrator)

## Context

This project makes several decisions that are expensive to reverse (storage substrate,
concurrency model, stack). We want the *reasoning* preserved — fittingly, since that is
the product's own thesis.

## Decision

We use Architecture Decision Records (MADR-lite) in `docs/adr/`. Significant decisions
get an ADR before or alongside the implementing PR. ADRs are immutable once Accepted and
are superseded, not edited.

## Consequences

- A durable trail of *why*, not just *what*.
- Small overhead per decision; offset by less re-litigation.
- Decision-type GitHub issues map 1:1 to ADRs.

## Alternatives considered

- **Decisions in commit messages / PRs only** — not discoverable enough for a decision
  that spans many files.
- **A single DECISIONS.md** — becomes a merge-conflict magnet; one-file-per-decision fits
  our own atomic-notes concurrency principle.
