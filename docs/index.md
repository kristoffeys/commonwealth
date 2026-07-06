---
title: Commonwealth
---

# Commonwealth

> The shared, agent-readable context every teammate's AI reads _before_ it acts.
> Instant onboarding. Anti-bus-factor. Plain markdown. Git-backed. Open source.

Commonwealth is a **multiplayer, git-backed, agent-readable second brain for teams** — a
shared repo of plain markdown (memory / decisions / work-state / people) that every
teammate's AI reads before acting and writes back to.

Most teams have a personal-notes story (Obsidian, `CLAUDE.md`) and an enterprise-search
story (Glean, Notion AI). Nothing in between owns the **reasoning layer** of a small team —
the _why_ behind decisions, the current work-state, the memory that would otherwise walk out
the door with whoever wrote it. Commonwealth is that layer, made multiplayer.

- **Plain markdown, git-backed.** Your knowledge is files you own — diffable, portable, no
  proprietary store to be locked into.
- **Per-project brains.** Each project gets its own brain (one git repo). Everyone reads and
  writes it through their existing AI (Claude Code first).
- **Agent-native.** Exposed over MCP, so a teammate's agent reads the brain before acting and
  writes back what it learns.
- **Conflict-free by design.** One fact per file with collision-proof names, so concurrent
  writers merge instead of clobbering each other.
- **Decisions are traced.** What was decided, when, by whom, and why — captured by default.
- **Secrets never sync.** Detected and blocked at capture, scrubbed before commit.

## Start here

<div class="grid cards" markdown>

- :material-rocket-launch: **[Quickstart](05-quickstart.md)**
  Get a brain running for one project in a couple of minutes, from npm.

- :material-file-tree: **[Data model](02-data-model.md)**
  The markdown/frontmatter schema for the four note kinds.

- :material-sitemap: **[Architecture](01-architecture.md)**
  Git-as-substrate, the concurrency model (the crux), and the auto-bridge.

- :material-server: **[Self-host](06-self-host.md)**
  Run the whole thing on infrastructure you control.

</div>

## Design principles

1. **Git is the substrate.** Markdown files are the source of truth; any DB/index is derived
   and disposable.
2. **Design out concurrency, don't resolve it.** Atomic, one-fact-per-file notes with
   collision-proof ids union-merge with zero conflicts.
3. **Prefer create/supersede over in-place edits.** History and reasoning stay visible.
4. **Curation is gated, and review-capable.** Auto-captured knowledge passes scope + dedup +
   secret gates before it reaches canon.

Every significant decision is recorded as an **[Architecture Decision Record](https://github.com/kristoffeys/commonwealth/tree/main/docs/adr)** in the repo.

---

Open source under [Apache-2.0](https://github.com/kristoffeys/commonwealth/blob/main/LICENSE).
Published on npm as [`@cmnwlth/cli`](https://www.npmjs.com/package/@cmnwlth/cli).
