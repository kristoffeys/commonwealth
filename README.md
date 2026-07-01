# Commonwealth — a multiplayer second brain for teams

> It's the shared, agent-readable context substrate every
> team member's AI reads _before_ it acts. Instant onboarding. Anti-bus-factor.
> Plain markdown. Git-backed. Open source.

Most teams have a personal-productivity story (`~/vault`, Obsidian, CLAUDE.md) and an
enterprise-search story (Glean, Notion AI). Nothing in between owns the **reasoning
layer** of a small team — the _why_ behind decisions, the current work-state, the
threads with people, the memory that would otherwise walk out the door with whoever
wrote it.

Commonwealth is that layer, made multiplayer:

- **Plain markdown, git-backed.** Your knowledge is files you own, diffable and
  portable. No proprietary store to be locked into or lose.
- **Per-project brains.** Each project gets its own brain (one git repo). Members
  read/write it through their existing AI (Claude Code first).
- **Agent-native.** Exposed over MCP so any teammate's agent reads the brain before
  acting and writes back what it learns.
- **Conflict-free by design.** One fact per file with collision-proof names, so
  concurrent writers union-merge instead of clobbering each other.
- **Secrets never sync.** Credentials (API keys, tokens, private keys, `.env`-style
  assignments) are detected and blocked at capture and scrubbed pre-commit.
- **Open source** (Apache-2.0). Distribution and trust wedge in a crowded market.

## How it fits together

```
Claude Code ──MCP──▶ @commonwealth/mcp ──▶ @commonwealth/core ──▶  brain/  (markdown, git repo)
                                          ▲                  │
 @commonwealth/sync (resident daemon) ─────────┘   pull/commit/push ↕  remote (any git host)
   watches the brain, syncs continuously, serializes writes, resolves conflicts as siblings
```

## Install as a Claude Code plugin

The `@commonwealth/plugin` bundles the MCP server + lifecycle hooks, so a session auto-loads
relevant brain context at start and captures learnings at end — **scope-gated** (personal
projects excluded) and routed through the review queue.

```bash
node packages/plugin/scripts/bundle.mjs   # vendors the built CLIs into the plugin (self-contained)
# then add the packages/plugin dir to Claude Code (local plugin dir or a git marketplace)
```

For a team, an admin auto-provisions it to everyone via Claude Code **managed settings**
(`extraKnownMarketplaces` + `enabledPlugins`) — see [`packages/plugin/README.md`](packages/plugin/README.md).
The steps below wire the same pieces manually (à la carte).

## Getting started

**Requirements:** Node ≥ 22, [pnpm](https://pnpm.io) 10+, git.

```bash
git clone https://github.com/kristoffeys/commonwealth.git
cd Commonwealth
pnpm install
```

### One command: `commonwealth init`

From the project you want a brain for, run **one** command. It is fully idempotent — run
it again anytime, it only does what's still missing:

```bash
node /path/to/Commonwealth/packages/cli/dist/index.js init
```

`init` does the whole setup end to end:

1. **Builds** the workspace if the `dist/` artifacts are missing (`pnpm -r build`).
2. **Creates** a brain for this project (or **joins** the one it already belongs to).
3. **Syncs** one or more folders into the brain: each is added to the capture allowlist and
   pinned to the brain via a `.commonwealth/brain` marker.
4. **Seeds** the brain from one or more repos — mining git history, ADRs, and agent config
   (`CLAUDE.md` / `.cursorrules` / `AGENTS.md`) — into the review queue.
5. **Registers** the MCP server with the `claude` CLI, pointed at the new brain.
6. **Starts** the sync daemon for the brain (detached).
7. **Ensures** your per-user scope config exists at `~/.commonwealth/config.json` (an empty
   `{ "allow": [], "deny": [] }` is created if it is missing) — so it is always present after
   `init`, even if you skip the allowlist step or no folder ends up allow-listed.

Run in a terminal, `init` is an **interactive wizard**: it asks each choice with a sensible
default (press Enter to accept). After the brain directory it asks **which directory to scan
for projects** (default: the parent of the current repo), discovers the git repos beneath it,
and lets you **multi-select** which folders to _sync_ into the brain and which repos to _seed_
from now (seed defaults to your sync selection). Selection accepts `all`, `none`, or a
comma/space list of the numbered items; Enter keeps the defaults. If no repos are found it
falls back to the current repo for both. It then asks whether to register MCP, start the
daemon, enable auto-ADR, and an optional brain git remote — then a final `Proceed?` before
making any changes. Declining `Proceed?` prints `Aborted.` and changes nothing.

Non-interactively (piped/CI, or with `--yes`) it never prompts: pass `--yes` to run with
defaults + flags, or the run is a no-op that tells you to re-run in a terminal. Common flags:

```bash
init --yes                  # non-interactive; skip the wizard and all prompts (defaults + flags)
init --brain <dir>          # where to create the brain (default: ~/.commonwealth/brains/<project>)
init --sync <dir,dir,...>   # folders to sync into the brain (default: this repo)
init --seed-repo <dir,...>  # repos to seed from now (default: the --sync folders)
init --reseed               # re-seed even if this project already resolves to a brain
init --auto-adr             # enable auto-ADR capture for the brain
init --remote <url>         # add <url> as the brain's git origin remote
init --no-scope             # skip adding folders to the capture allowlist
init --no-seed              # create the brain but skip mining/staging candidates
init --no-mcp               # skip registering the MCP server
init --no-daemon            # skip starting the sync daemon
init --no-build             # skip the workspace build
```

`--sync` and `--seed-repo` both take a comma-separated list of directories, so a single
`init --yes --sync ~/work/a,~/work/b --seed-repo ~/work/a` wires two folders into the brain
and seeds from one of them.

> Not yet published to npm — for now the tools run from the built `dist/` in this repo.
> `commonwealth init` and the plugin's auto-provisioning already work from the built repo;
> npm-published binaries are a later milestone (see the roadmap). When missing steps are
> needed, `claude` and `pnpm` must be on `PATH`; if either is absent, `init` skips that
> step with a note instead of failing.

That's it — open a Claude Code session in the project and ask it something your team
already knows. The rest of this section documents the pieces `init` wires up, in case you
want to run or reconfigure them individually.

### 1. Create a brain (done by `init`)

A brain is just a git repository. `init` creates one under
`~/.commonwealth/brains/<project>` (override with `--brain`). To scaffold one by hand
instead, the four folders (`memory/ decisions/ work-state/ people/`) are created on first
write:

```bash
mkdir ~/my-brain && cd ~/my-brain && git init
# optional: back it with a remote so teammates can share it
git remote add origin git@github.com:you/my-brain.git
```

### 2. Read/write the brain from Claude Code (MCP) (done by `init`)

`init` runs the registration below for you. To do it manually, point the MCP server at
your brain:

```bash
claude mcp add commonwealth \
  --env COMMONWEALTH_BRAIN_DIR="$HOME/my-brain" \
  -- node "/path/to/Commonwealth/packages/mcp/dist/index.js"
```

Then, in a Claude Code session, the brain is available through these tools:

| Tool              | What it does                                               |
| ----------------- | ---------------------------------------------------------- |
| `search`          | full-text (FTS5) search over the brain                     |
| `read`            | read a note by path                                        |
| `remember`        | write a new note (memory / decision / work-state / person) |
| `list-work-state` | list active workstreams                                    |
| `who-is`          | look up a person note                                      |

### 3. Keep it synced (resident daemon) (done by `init`)

`init` starts this daemon for you (detached). To run it yourself so local edits and
teammates' changes converge continuously:

```bash
node /path/to/Commonwealth/packages/sync/dist/index.js start --dir "$HOME/my-brain"
# one-shot instead of resident:  ... sync --dir "$HOME/my-brain"
# status / stop:                 ... status --dir ...   |   ... stop --dir ...
```

The daemon commits + pushes on change, pulls on a poll interval, rebuilds the search
index, and — on a genuine same-file conflict — keeps **both** versions as sibling notes
(never overwrites) with a conflict record for review.

### 4. Review auto-captured knowledge

Curated notes land in a `staging/` queue (never straight to canon). Review and promote
them with the `commonwealth-curate` CLI:

```bash
node /path/to/Commonwealth/packages/curate/dist/index.js list --dir "$HOME/my-brain"
#   approve <id...> | reject <id...> | approve-all
```

The curation engine dedupes near-identical notes and drops trivial ones before they
reach the queue; approval moves a note into canon. Automatic capture at session end and
relevance-gated injection at session start are wired by the plugin (see above).

### 5. Keep personal projects out of the brain (scope)

A **per-user, local** allow/deny list decides which project folders are in scope. Only
sessions whose folder is in scope are ever captured or injected — personal projects stay
out. It lives in `~/.commonwealth/config.json` (overridable via `$COMMONWEALTH_CONFIG`) and
is never synced. `commonwealth init` always ensures this file exists (creating an empty
`{ "allow": [], "deny": [] }` if missing), so it is present even when no folder is allow-listed.

```bash
CURATE="node /path/to/Commonwealth/packages/curate/dist/index.js"
$CURATE scope allow ~/work          # only capture work under here…
$CURATE scope deny  ~/work/secret   # …except this (deny wins)
$CURATE scope check --cwd "$PWD"    # → in-scope | out-of-scope
$CURATE scope show
```

Rule: in scope if `(allow is empty OR under an allow entry) AND under no deny entry`.
Default (no config) = everything in scope; add a deny (or a narrow allow) to exclude.

## Seed the brain from your repo (cold-start)

A fresh brain shouldn't be empty. Seeding is part of `commonwealth init` (see [Getting
started](#one-command-commonwealth-init)): it detects your repo, mines its existing
knowledge (git history — merged PRs + notable commits — ADRs, and agent-config like
`CLAUDE.md` / `.cursorrules` / `AGENTS.md`), previews what it found, and on confirm stages
the candidates into the review queue. Pass `--no-seed` to create the brain without mining.

A teammate running `init` where a brain already exists **joins** it instead of re-seeding
(TTFV ≈ 0 — they clone an already-full brain). Or drive the pieces à la carte:

```bash
SEED="node /path/to/Commonwealth/packages/seed/dist/index.js"
$SEED gather --repo "$PWD" | commonwealth-curate capture --dir "$HOME/my-brain"
commonwealth-curate list --dir "$HOME/my-brain"                    # review, then approve
```

Everything lands in the staging review queue first — nothing enters canon unreviewed.

## Configuration

Commonwealth has two config layers, deliberately separate:

| File                           | Scope                 | Synced?           | Holds                                                 |
| ------------------------------ | --------------------- | ----------------- | ----------------------------------------------------- |
| `~/.commonwealth/config.json`       | per-user, per-machine | no                | the folder **scope** allow/deny (above)               |
| `<brain>/.commonwealth/config.json` | shared with the brain | yes (in the repo) | brain **name**, remotes, and global **feature flags** |

Brain-level **feature flags** are toggled with the CLI and sync with the brain:

```bash
CURATE="node /path/to/Commonwealth/packages/curate/dist/index.js"
$CURATE feature list --dir "$HOME/my-brain"
$CURATE feature enable autoAdr --dir "$HOME/my-brain"   # opt in per team
```

`autoAdr` (default **off**): when on, captured **decisions** are auto-recorded as
ADR-style `decision` notes in the brain (they still pass the review queue and respect the
scope filter). When off, decision candidates are dropped.

## Packages

| Package           | Status | What it is                                                                                                  |
| ----------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| `@commonwealth/core`   | ✅     | Schema (4 note kinds), atomic note IO, brain scaffold, FTS5 index + derived `COMMONWEALTH.md`/`INDEX.md`         |
| `@commonwealth/mcp`    | ✅     | MCP server exposing a brain to Claude Code (`commonwealth-mcp`)                                                  |
| `@commonwealth/sync`   | ✅     | Resident sync daemon + engine: git pull/commit/push, write queue, conflict-as-siblings (`commonwealth-sync`)     |
| `@commonwealth/curate` | ✅     | Curation (dedupe/relevance) + in-repo review queue + per-user scope filter (`commonwealth-curate`); hooks in M4  |
| `@commonwealth/plugin` | ✅     | Claude Code plugin: MCP + scope-gated SessionStart/SessionEnd hooks + /commonwealth commands + auto-provisioning |
| `@commonwealth/seed`   | ✅     | Cold-start seeding: git-history miner + agent-config importer → candidate notes (`commonwealth-seed`)            |
| `@commonwealth/cli`    | ✅     | The unified `commonwealth` CLI — `init` onboarding wizard (detect → preview → confirm → seed, + join mode)       |

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
| [`docs/01-architecture.md`](docs/01-architecture.md) | Git-as-substrate, the concurrency model (the crux), sync daemon, curation |
| [`docs/02-data-model.md`](docs/02-data-model.md)     | The markdown schema: memory / decisions / work-state / people-threads     |
| [`docs/03-distribution.md`](docs/03-distribution.md) | Auto-provisioning into Claude, OSS + monetization                         |
| [`docs/04-roadmap.md`](docs/04-roadmap.md)           | Phased build plan and open questions                                      |
| [`docs/adr/`](docs/adr)                              | Architecture Decision Records                                             |


## License

[Apache-2.0](LICENSE) © 2026 Kristof Feys
