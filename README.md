# Commons — a multiplayer second brain for teams

> Working title: **Commons**. It's the shared, agent-readable context substrate every
> team member's AI reads _before_ it acts. Instant onboarding. Anti-bus-factor.
> Plain markdown. Git-backed. Open source.

Most teams have a personal-productivity story (`~/vault`, Obsidian, CLAUDE.md) and an
enterprise-search story (Glean, Notion AI). Nothing in between owns the **reasoning
layer** of a small team — the _why_ behind decisions, the current work-state, the
threads with people, the memory that would otherwise walk out the door with whoever
wrote it.

Commons is that layer, made multiplayer:

- **Plain markdown, git-backed.** Your knowledge is files you own, diffable and
  portable. No proprietary store to be locked into or lose.
- **Per-project brains.** Each project gets its own brain (one git repo). Members
  read/write it through their existing AI (Claude Code first).
- **Agent-native.** Exposed over MCP so any teammate's agent reads the brain before
  acting and writes back what it learns.
- **Conflict-free by design.** One fact per file with collision-proof names, so
  concurrent writers union-merge instead of clobbering each other.
- **Open source** (Apache-2.0). Distribution and trust wedge in a crowded market.

## How it fits together

```
Claude Code ──MCP──▶ @commons/mcp ──▶ @commons/core ──▶  brain/  (markdown, git repo)
                                          ▲                  │
 @commons/sync (resident daemon) ─────────┘   pull/commit/push ↕  remote (any git host)
   watches the brain, syncs continuously, serializes writes, resolves conflicts as siblings
```

## Getting started

**Requirements:** Node ≥ 22, [pnpm](https://pnpm.io) 10+, git.

```bash
git clone https://github.com/kristoffeys/team-second-brain.git
cd team-second-brain
pnpm install
pnpm build          # builds @commons/core, @commons/mcp, @commons/sync
pnpm test           # 41 tests
```

> Not yet published to npm — for now the tools run from the built `dist/` in this repo.
> A `commons init` CLI, published binaries, and auto-provisioning arrive in later
> milestones (see the roadmap).

### 1. Create a brain

A brain is just a git repository. The four folders (`memory/ decisions/ work-state/
people/`) are created on first write, or scaffold them up front:

```bash
mkdir ~/my-brain && cd ~/my-brain && git init
# optional: back it with a remote so teammates can share it
git remote add origin git@github.com:you/my-brain.git
```

### 2. Read/write the brain from Claude Code (MCP)

Register the MCP server, pointed at your brain:

```bash
claude mcp add commons \
  --env COMMONS_BRAIN_DIR="$HOME/my-brain" \
  -- node "/path/to/team-second-brain/packages/mcp/dist/index.js"
```

Then, in a Claude Code session, the brain is available through these tools:

| Tool              | What it does                                               |
| ----------------- | ---------------------------------------------------------- |
| `search`          | full-text (FTS5) search over the brain                     |
| `read`            | read a note by path                                        |
| `remember`        | write a new note (memory / decision / work-state / person) |
| `list-work-state` | list active workstreams                                    |
| `who-is`          | look up a person note                                      |

### 3. Keep it synced (resident daemon)

Run the sync daemon so local edits and teammates' changes converge continuously:

```bash
node /path/to/team-second-brain/packages/sync/dist/index.js start --dir "$HOME/my-brain"
# one-shot instead of resident:  ... sync --dir "$HOME/my-brain"
# status / stop:                 ... status --dir ...   |   ... stop --dir ...
```

The daemon commits + pushes on change, pulls on a poll interval, rebuilds the search
index, and — on a genuine same-file conflict — keeps **both** versions as sibling notes
(never overwrites) with a conflict record for review.

## Packages

| Package            | Status | What it is                                                                                              |
| ------------------ | ------ | ------------------------------------------------------------------------------------------------------- |
| `@commons/core`    | ✅     | Schema (4 note kinds), atomic note IO, brain scaffold, FTS5 index + derived `COMMONS.md`/`INDEX.md`     |
| `@commons/mcp`     | ✅     | MCP server exposing a brain to Claude Code (`commons-mcp`)                                              |
| `@commons/sync`    | ✅     | Resident sync daemon + engine: git pull/commit/push, write queue, conflict-as-siblings (`commons-sync`) |
| Claude Code plugin | ⏳     | Auto-provisioning + lifecycle hooks (roadmap M4)                                                        |
| Curation agent     | ⏳     | Capture → curate → review → propagate (roadmap M3)                                                      |

## Development

```bash
pnpm build         # build all packages (tsup)
pnpm typecheck     # tsc --noEmit across packages
pnpm test          # vitest
pnpm lint          # eslint
pnpm format        # prettier --write
```

Conventions and non-negotiable design principles live in
[`CLAUDE.md`](CLAUDE.md); architecture decisions in [`docs/adr/`](docs/adr).

## Docs

| Doc                                                  | What it covers                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------- |
| [`docs/00-vision.md`](docs/00-vision.md)             | Positioning, competitors, edge, wedge, risks                              |
| [`docs/01-architecture.md`](docs/01-architecture.md) | Git-as-substrate, the concurrency model (the crux), sync daemon, curation |
| [`docs/02-data-model.md`](docs/02-data-model.md)     | The markdown schema: memory / decisions / work-state / people-threads     |
| [`docs/03-distribution.md`](docs/03-distribution.md) | Auto-provisioning into Claude, OSS + monetization                         |
| [`docs/04-roadmap.md`](docs/04-roadmap.md)           | Phased build plan and open questions                                      |
| [`docs/adr/`](docs/adr)                              | Architecture Decision Records                                             |

## Status

Early build. **M0** (substrate) and **M1** (MCP server) and **M2** (resident sync
daemon) are done; **M3** (the auto-bridge: capture → curate → review → propagate) is
next. Dogfood partner: **Antenna** (a potential first user). This repo is itself the
first brain.

## License

[Apache-2.0](LICENSE) © 2026 Kristof Feys
