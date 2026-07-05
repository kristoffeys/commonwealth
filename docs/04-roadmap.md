---
title: Roadmap & Build Plan
type: project
status: draft
updated: 2026-07-01
tags: [roadmap, milestones, planning]
---

# Roadmap & Build Plan

Phased so each milestone is independently useful and dogfoodable on a real team. The order
front-loads the two things that are both hard _and_ differentiating (concurrency-safe
substrate, then the auto bridge), because those are the moat.

## M0 — Substrate & schema (walking skeleton)

**Goal:** a git repo of markdown you can read/write by hand and via a minimal tool, with
the concurrency model proven.

- Define + document the schema (done: [`02-data-model.md`](02-data-model.md)).
- Repo scaffold: folders, `COMMONWEALTH.md`, `.commonwealth/` config, `.gitattributes`
  (`merge=union` on derived/append files).
- Atomic-note writer: `<date>-<slug>-<shortid>` naming; union-merge verified with a
  concurrent-write test.
- Derived index generator (SQLite; embeddings can come later) + `COMMONWEALTH.md`/`INDEX.md`
  regeneration.
- **Exit:** two people writing concurrently never conflict; index rebuilds from files.

## M1 — MCP server + read/write from Claude Code

**Goal:** the agent reads the brain before acting and writes back.

- MCP server: `search`, `read`, `remember`, `list-work-state`, `who-is`.
- Manual `/commonwealth` commands.
- **Exit:** in Claude Code, `recall` surfaces a real note; `remember` lands a note in
  staging.

## M2 — Sync daemon + queue

**Goal:** local ↔ remote automation and the same-file edit path.

- Daemon: pull on start, commit+push on write, index rebuild.
- Write queue for same-file edits (acquire → rebase → apply → push → retry).
- Conflict → sibling notes + `conflict:` task (never silent overwrite).
- **Exit:** two machines converge without data loss under concurrent same-file edits.

## M3 — The auto bridge (capture → curate → commit → propagate)

**Goal:** the differentiator. Learnings become shared knowledge automatically.

- `Stop`/`SessionEnd` capture hook → staging.
- Curation agent: dedupe, verify (Kage-style), contradiction check, **relevance gate**.
- Curation-as-review: promotion opens a PR / review queue.
- `SessionStart` pull + **relevance-gated context injection** (token-budgeted).
- **Exit:** a decision made in one teammate's session shows up, curated, in another's
  next session — without anyone running git by hand.

## M4 — Auto-provisioning & multi-brain

**Goal:** joining the team mounts the right brains with ~zero setup.

- Claude Code plugin packaging (MCP + hooks + registry) via managed settings.
- Brain registry: marker file + remote/org convention + `org-brain` fallback.
- Per-project brain resolution; clone-on-demand; git-permission access model.
- Secret scanner in the daemon (pre-commit scrub).
- **Exit:** a new teammate runs `claude` in a project and the brain is just
  there.

## M5 — Hardening & OSS launch

- Docs, quickstart, self-host guide.
- License decision finalized; public repo polish; plugin marketplace listing.
- A real-team case study as the reference dogfood.
- (Parallel track) SOW-diff wedge on the same substrate — the monetizable on-ramp.

## Cross-cutting / later

- Embeddings: pluggable local vs. hosted.
- Cross-agent MCP (Codex/Cursor/Gemini CLI) — portability story.
- Hosted/Team tier: managed daemon, hosted curation, team feed, SSO.
- Org-brain graduation flow (project → org knowledge promotion).

## Key open questions (decide before/at each milestone)

1. **License** — MIT vs. Apache-2.0 (patent grant). _(M0/M5)_
2. **Review gate default** — PR-per-promotion vs. lightweight in-repo queue. _(M3)_
3. **Embeddings** — local model vs. hosted for the index. _(M1/M3)_
4. **Relevance-injection budget** — ranking + token budget at SessionStart. _(M3)_
5. **Managed-settings distribution** — verify exact Claude Code plugin-push path. _(M4)_
6. **Hosted daemon topology** — per-user vs. multi-tenant for the paid tier. _(M5)_
7. **Repo granularity** — per-project repos vs. monorepo-of-brains at scale. _(M0/M4)_
