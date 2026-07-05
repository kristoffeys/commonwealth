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
  assignments) are detected and blocked at capture and scrubbed pre-commit. Opt into
  high-entropy detection (with a per-brain allowlist) via `secretScan` in the brain config.
- **Open source** (Apache-2.0). Distribution and trust wedge in a crowded market.

## How it fits together

```
Claude Code ──MCP──▶ @cmnwlth/mcp ──▶ @cmnwlth/core ──▶  brain/  (markdown, git repo)
                                          ▲                  │
 @cmnwlth/sync (resident daemon) ─────────┘   pull/commit/push ↕  remote (any git host)
   watches the brain, syncs continuously, serializes writes, resolves conflicts as siblings
```

## Install as a Claude Code plugin

The **supported install is the plugin** (ADR-0012). The `@cmnwlth/plugin` bundles the MCP
server + lifecycle hooks and installs at **user scope (global)**, so the `commonwealth`
tools (`search`/`read`/`remember`/…) and the auto-bridge are available in **every** session —
not just the directory you installed from. A session auto-loads relevant brain context at start
and captures learnings at end — **scope-gated** (personal projects excluded) and routed through
the review queue.

Add this repo as a marketplace, then install the plugin:

```bash
claude plugin marketplace add kristoffeys/commonwealth   # or a path/fork/mirror of this repo
claude plugin install commonwealth@cmnwlth
```

> **Then restart Claude Code and run `/mcp`.** Plugins only (re)load at session start, so a
> session already running when you install will still show the plugin as "failed to load" —
> restart, and `/mcp` should list the `commonwealth` server. Open a session inside a synced
> project (e.g. one you ran `commonwealth init` in) and the right brain loads automatically.

**Per-repo routing is dynamic.** There is no baked-in brain: the SessionStart hook resolves the
real session cwd → its brain via the registry (ADR-0011), and the MCP server independently
resolves its brain via `@cmnwlth/core.resolveBrainDir` — so one global install serves every
repo and each session talks to the right brain. `commonwealth init` performs this install for you
(and wires the registry mapping); it replaced the old raw local-scope `claude mcp add`, which was
invisible outside its install dir and pinned one brain.

For a team, an admin auto-provisions it to everyone via Claude Code **managed settings**
(`extraKnownMarketplaces` + `enabledPlugins`) — see [`packages/plugin/README.md`](packages/plugin/README.md).
The steps below wire the same pieces manually (à la carte).

## Getting started

**Requirements:** Node ≥ 22, git (plus [pnpm](https://pnpm.io) 10+ for the from-source path).

Once published to npm (#49), install the CLI directly:

```bash
npm i -g @cmnwlth/cli      # then: commonwealth init
# or run without installing:    npx @cmnwlth/cli init
```

Until the first release, build from source:

```bash
git clone https://github.com/kristoffeys/commonwealth.git
cd Commonwealth
pnpm install
pnpm build            # build the CLI + all packages
pnpm link-cli         # put `commonwealth` on your PATH (pre-npm wrapper → ~/.local/bin, #49)
```

> `pnpm link-cli` writes a tiny wrapper to `~/.local/bin/commonwealth` that runs the built CLI
> from this repo, so every `commonwealth <verb>` below just works. Make sure `~/.local/bin` is
> on your `PATH`. Prefer not to link? Every command also runs as
> `node /path/to/Commonwealth/packages/cli/dist/index.js <verb>`.

### One command: `commonwealth init`

From the project you want a brain for, run **one** command. It is fully idempotent — run
it again anytime, it only does what's still missing:

```bash
commonwealth init
```

`init` does the whole setup end to end:

1. **Builds** the workspace if the `dist/` artifacts are missing (`pnpm -r build`).
2. **Creates** a brain for this project (or **joins** the one it already belongs to).
3. **Syncs** one or more folders into the brain: each is added to the capture allowlist and
   wired to the brain in the **global user registry** (`~/.commonwealth/registry.json`), plus a
   convenience `~/.commonwealth/brains/<name>` symlink so you can `ls`/`cd` your brains. (A
   per-project `.commonwealth/brain` marker remains an optional manual override.)
4. **Seeds** the brain from one or more repos — mining git history, ADRs, and agent config
   (`CLAUDE.md` / `.cursorrules` / `AGENTS.md`) — into the review queue.
5. **Installs** the Commonwealth plugin (global, user scope) — bundling the MCP server + the
   scope-gated SessionStart/SessionEnd hooks — so every session reads/writes the brain and the
   right brain is resolved per repo (ADR-0011/0012).
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
falls back to the current repo for both. It then asks whether to install the plugin, start the
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
init --no-plugin            # skip installing the plugin (MCP + hooks); alias: --no-mcp
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

### Everyday commands

`init` is for onboarding; day-to-day you use `commonwealth <verb>`. Every command resolves the
brain from the registry for the current directory — no `--dir`, no re-running `init` (ADR-0016):

```bash
commonwealth reseed [<repo>...] [--all]   # mine repo(s) into the mapped brain and capture
commonwealth config list                  # show the brain's config + feature flags
commonwealth config set autoPromote false # e.g. require manual review before canon
commonwealth status                       # review queue + sync-daemon state
commonwealth sync start|stop|once         # control/run the sync daemon
commonwealth pending                      # notes awaiting review
commonwealth promote <id...> | --all      # approve staged notes into canon
commonwealth reject <id...>               # discard staged notes
commonwealth scope show|allow|deny|check  # per-user capture scope
commonwealth recall <query>               # search the brain
```

Tip: to review a bulk reseed instead of auto-landing it, `commonwealth config set autoPromote
false` first, then `reseed`, then `pending` / `promote`.

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

`init` installs the plugin for you (global, user scope), which registers the
`commonwealth` MCP server. To do it manually, add the marketplace and install the plugin:

```bash
claude plugin marketplace add kristoffeys/commonwealth
claude plugin install commonwealth@cmnwlth
```

The server resolves its brain per repo via the registry (ADR-0011); to pin one brain for a
one-off standalone run you can still `export COMMONWEALTH_BRAIN_DIR="$HOME/my-brain"` before
launching Claude Code (it takes precedence). Then, in a Claude Code session, the brain is
available through these tools:

| Tool              | What it does                                               |
| ----------------- | ---------------------------------------------------------- |
| `search`          | full-text (FTS5) search over the brain                     |
| `read`            | read a note by path                                        |
| `remember`        | record a new note through the curation gate (secret + dedup + autoPromote) |
| `list-work-state` | list active workstreams                                    |
| `who-is`          | look up a person note                                      |

### 3. Keep it synced (resident daemon) (done by `init`)

`init` starts this daemon for you (detached). To run it yourself so local edits and
teammates' changes converge continuously:

```bash
commonwealth sync start     # resident daemon for the brain mapped to this repo
commonwealth sync once      # one-shot sync instead of resident
commonwealth sync stop      # stop it; `commonwealth status` shows daemon state
```

Check whether the brain is decaying with the trust rollup:

```bash
commonwealth health         # freshness/trust score + stale / unverified / contradicted / orphaned counts
commonwealth consolidate    # supersede cross-user near-duplicate canon notes (--dry-run to preview)
```

The daemon commits + pushes on change, pulls on a poll interval, rebuilds the search
index, and — on a genuine same-file conflict — keeps **both** versions as sibling notes
(never overwrites) with a conflict record for review.

### 4. Auto-promotion (and optional review)

By default (`autoPromote`, ADR-0014) captured notes promote **straight into canon** — the
curation engine still dedupes near-identical notes, drops trivial ones, and scrubs secrets
first; only the manual review step is skipped. Turn the per-brain flag off to hold captures
in a `staging/` queue for approval instead. The flag lives in the brain's
`.commonwealth/config.json`, so it syncs team-wide:

```bash
commonwealth config set autoPromote false   # require manual review for this brain
commonwealth pending                        # what's awaiting review
commonwealth promote <id...> | --all        # approve into canon
commonwealth reject  <id...>                # discard
```

Automatic capture at session end and relevance-gated injection at session start are wired
by the plugin (see above).

### 5. Keep personal projects out of the brain (scope)

A **per-user, local** allow/deny list decides which project folders are in scope. Only
sessions whose folder is in scope are ever captured or injected — personal projects stay
out. It lives in `~/.commonwealth/config.json` (overridable via `$COMMONWEALTH_CONFIG`) and
is never synced. `commonwealth init` always ensures this file exists (creating an empty
`{ "allow": [], "deny": [] }` if missing), so it is present even when no folder is allow-listed.

```bash
commonwealth scope allow ~/work          # only capture work under here…
commonwealth scope deny  ~/work/secret   # …except this (deny wins)
commonwealth scope check                 # → in-scope | out-of-scope (for the cwd)
commonwealth scope show
```

Rule: in scope if `(allow is empty OR under an allow entry) AND under no deny entry`.
Default (no config) = everything in scope; add a deny (or a narrow allow) to exclude.

## Seed the brain from your repo (cold-start)

A fresh brain shouldn't be empty. Seeding is part of `commonwealth init` (see [Getting
started](#one-command-commonwealth-init)): it detects your repo, mines its existing
knowledge (git history — merged PRs + notable commits — ADRs, and agent-config like
`CLAUDE.md` / `.cursorrules` / `AGENTS.md`), previews what it found, and on confirm captures
the candidates. With `autoPromote` on (the default) they land in canon; with it off they
stage into the review queue. Pass `--no-seed` to create the brain without mining.

A teammate running `init` where a brain already exists **joins** it instead of re-seeding
(TTFV ≈ 0 — they clone an already-full brain). To re-mine a repo into an existing brain
later, use the unified verb:

```bash
commonwealth reseed          # mine the current repo into its mapped brain and capture
commonwealth reseed --all    # mine every git repo found under the cwd
commonwealth pending         # review the candidates (if autoPromote is off)
```

With `autoPromote` on (default) captures — including seeded mines — land in canon after the
dedup/validation/secret gates. Set the per-brain `autoPromote` flag to `false` to route
everything through the `staging/` review queue first (ADR-0014).

## Configuration

Commonwealth keeps a few files under `~/.commonwealth/` and one inside each brain,
deliberately separate:

| File                                | Scope                 | Synced?           | Holds                                                            |
| ----------------------------------- | --------------------- | ----------------- | --------------------------------------------------------------- |
| `~/.commonwealth/config.json`       | per-user, per-machine | no                | the folder **scope** allow/deny (above)                         |
| `~/.commonwealth/registry.json`     | per-user, per-machine | no                | **brain routing**: `prefix → brain` mappings (resolver layer 3) |
| `~/.commonwealth/brains/<name>`     | per-user, per-machine | no                | convenience **symlink** to each brain dir (for `ls`/`cd`)       |
| `<brain>/.commonwealth/config.json` | shared with the brain | yes (in the repo) | brain **name**, remotes, and global **feature flags**           |

`registry.json` is the default source of truth for which brain a directory maps to — written
by `init` for every synced folder. A per-project `.commonwealth/brain` marker file resolves
ahead of the registry when you need to pin one project explicitly (an optional manual override).

Brain-level **feature flags** are toggled with the CLI and sync with the brain:

```bash
commonwealth config list                 # show name, remotes, and all feature flags
commonwealth config set autoAdr true      # opt in per team (syncs with the brain)
```

`autoAdr` (default **off**): when on, captured **decisions** are auto-recorded as
ADR-style `decision` notes in the brain (they still pass the review queue and respect the
scope filter). When off, decision candidates are dropped.

## Packages

| Package           | Status | What it is                                                                                                  |
| ----------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| `@cmnwlth/core`   | ✅     | Schema (4 note kinds), atomic note IO, brain scaffold, FTS5 index + derived `COMMONWEALTH.md`/`INDEX.md`         |
| `@cmnwlth/mcp`    | ✅     | MCP server exposing a brain to Claude Code (`commonwealth-mcp`)                                                  |
| `@cmnwlth/sync`   | ✅     | Resident sync daemon + engine: git pull/commit/push, write queue, conflict-as-siblings (`commonwealth-sync`)     |
| `@cmnwlth/curate` | ✅     | Curation (dedupe/relevance) + in-repo review queue + per-user scope filter; drives the plugin's capture/inject hooks |
| `@cmnwlth/plugin` | ✅     | Claude Code plugin: MCP + scope-gated SessionStart/SessionEnd hooks + /commonwealth commands + auto-provisioning |
| `@cmnwlth/seed`   | ✅     | Cold-start seeding: git-history miner + agent-config importer → candidate notes (`commonwealth-seed`)            |
| `@cmnwlth/cli`    | ✅     | The unified `commonwealth` CLI — `init` onboarding wizard (detect → preview → confirm → seed, + join mode)       |

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
| [`docs/05-quickstart.md`](docs/05-quickstart.md)     | Get a brain running for one project in minutes (from source)              |
| [`docs/06-self-host.md`](docs/06-self-host.md)       | Share a brain across a team over your own git remote; per-brain config    |
| [`docs/01-architecture.md`](docs/01-architecture.md) | Git-as-substrate, the concurrency model (the crux), sync daemon, curation |
| [`docs/02-data-model.md`](docs/02-data-model.md)     | The markdown schema: memory / decisions / work-state / people-threads     |
| [`docs/03-distribution.md`](docs/03-distribution.md) | Auto-provisioning into Claude, OSS + monetization                         |
| [`docs/04-roadmap.md`](docs/04-roadmap.md)           | Phased build plan and open questions                                      |
| [`docs/adr/`](docs/adr)                              | Architecture Decision Records                                             |


## License

[Apache-2.0](LICENSE) © 2026 Kristof Feys
