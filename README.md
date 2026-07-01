# Commons — a multiplayer second brain for teams

> Working title: **Commons**. It's the shared, agent-readable context substrate every
> team member's AI reads *before* it acts. Instant onboarding. Anti-bus-factor.
> Plain markdown. Git-backed. Open source.

Most teams have a personal-productivity story (`~/vault`, Obsidian, CLAUDE.md) and an
enterprise-search story (Glean, Notion AI). Nothing in between owns the **reasoning
layer** of a small team — the *why* behind decisions, the current work-state, the
threads with people, the memory that would otherwise walk out the door with whoever
wrote it.

Commons is that layer, made multiplayer:

- **Plain markdown, git-backed.** Your knowledge is files you own, diffable and
  portable. No proprietary store to be locked into or lose.
- **Per-project brains.** Each project gets its own brain. Members read/write it
  through their existing AI (Claude Code first).
- **Agent-native.** Exposed over MCP so any teammate's agent reads the brain before
  acting and writes back what it learns.
- **Auto-provisioned.** Joining a team (semi-)automatically mounts the right project
  brains into your Claude setup; knowledge is pulled at session start and curated back
  as you work.
- **Open source.** Distribution and trust wedge in a crowded market.

## Why now / why us

See [`docs/00-vision.md`](docs/00-vision.md) for the competitive landscape and the
specific white space (nobody ships *git-backed × true-multiplayer × open-source*),
the wedge strategy, and the honest risks.

## Spec set

| Doc | What it covers |
|---|---|
| [`docs/00-vision.md`](docs/00-vision.md) | Positioning, competitors, edge, wedge, risks |
| [`docs/01-architecture.md`](docs/01-architecture.md) | Git-as-substrate, the concurrency model (the crux), sync daemon, curation |
| [`docs/02-data-model.md`](docs/02-data-model.md) | The markdown schema: memory / decisions / work-state / people-threads |
| [`docs/03-distribution.md`](docs/03-distribution.md) | Auto-provisioning into Claude, OSS + monetization |
| [`docs/04-roadmap.md`](docs/04-roadmap.md) | Phased build plan and open questions |

## Status

Spec / pre-build. Dogfood partner: **Antenna**. This repo itself is the first brain.
