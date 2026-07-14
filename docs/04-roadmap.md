---
title: Status & roadmap
type: project
status: draft
updated: 2026-07-14
tags: [roadmap, status]
---

# Status & roadmap

Commonwealth is built in phases, each independently useful on a real team. The substrate and the
auto-bridge came first because they're both the hardest part and the differentiator.

## Shipped

- **Substrate & schema** — a git repo of atomic markdown notes (memory / decisions / work-state /
  people) with collision-proof names, so concurrent writers union-merge instead of conflicting. A
  disposable SQLite index (FTS + optional embeddings) rebuilds from the files.
- **MCP server + Claude Code/Codex plugin** — `search / read / remember / ask / list-work-state /
  who-is`, proactive context, and automatic capture in both hosts.
- **Sync daemon** — pull on session start, commit + push on write, index rebuild, and same-file
  conflicts kept as sibling notes (never a silent overwrite).
- **The auto-bridge** — Claude `SessionEnd` / Codex turn-boundary capture → curation gate (dedup,
  secret scan, relevance) → review queue → propagate; session- and prompt-scoped context injection.
- **Decisions by default** — auto-detected decisions and the explicit `/commonwealth:decide` path
  record what/when/who/why.
- **Onboarding & multi-brain** — `commonwealth init` wizard, cold-start seeding (git history /
  ADRs / agent config), a per-project brain registry, clone-on-demand, and git-permission access.
- **Hardening** — secret scanning, `commonwealth doctor`, `verify-restore` (disaster-recovery
  proof), `emit` for Cursor/Copilot/Codex, and a 60-second `demo`.

## Next

- **Org-brain auto-graduation** — promote knowledge that recurs across ≥ 2 project brains into a
  shared org brain.
- **Semantic contradiction detection** — flag notes that _disagree_ with canon (a follow-up to
  the embeddings-backed dedup already shipped).
- **Broader cross-agent support** — bring other hosts up from emitted-context fallback to the
  live MCP/lifecycle parity now available in Claude Code and Codex.

Track the live board in the repo's GitHub Project and issues.
