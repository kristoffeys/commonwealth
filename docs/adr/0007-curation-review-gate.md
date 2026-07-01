# 7. Curation & the review gate: in-repo staging queue

- Status: Accepted
- Date: 2026-07-01
- Deciders: kristof (owner), Claude (orchestrator)
- Relates: [architecture §3](../01-architecture.md), GitHub issues #9, #10, #11, #12, #22

## Context

The auto-bridge (M3) turns session learnings into shared knowledge: capture → curate →
review → propagate. The open decision (#22) was how curated notes get reviewed before
becoming canon: a GitHub PR per promotion, or a lightweight in-repo queue.

## Decision

**A lightweight in-repo staging review queue.**

- Proposed notes are written to a `staging/` area in the brain, never straight to canon.
- A `commons-curate` CLI (and later an MCP tool + the M4 plugin) lists pending notes and
  **approves** (move into the canonical kind folder, commit) or **rejects** (discard)
  them. Approval is the human/trusted-agent gate; junk never auto-lands.
- Curation is pluggable via a `Curator` seam. The **default curator** is deterministic:
  **dedupe** (token-similarity against existing canon + staged notes → skip near-dupes)
  and a **relevance gate** (drop trivial/boilerplate candidates). Semantic dedupe,
  contradiction detection, and code-verification are **deferred** to an LLM/embedding-
  backed curator once the `Embedder` seam lands (ADR-0005) — the staging+review gate is
  the quality backstop until then.
- **Capture** (#9) and **relevance-gated injection** (#12) ship here as library
  functions (`stage`/`curate`, `selectRelevant`); their wiring into Claude Code
  SessionStart/Stop hooks lands with the M4 plugin.

## Consequences

- Fast, offline, git-host-agnostic; works for a solo user and a small team alike, and
  matches the ownership thesis (no GitHub coupling in the core gate).
- No rich PR diff UI — acceptable for M3; a PR-based gate can be layered on later for
  teams that want it (the two are not mutually exclusive).
- The `Curator` seam keeps the door open for LLM-backed curation without reworking the
  staging/review mechanics.

## Alternatives considered

- **PR-per-promotion** — familiar review UX + audit trail, but couples the gate to GitHub
  and is noisy under frequent auto-capture. Deferred as an optional layer, not the core.
