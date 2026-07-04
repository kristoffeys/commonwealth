# Quickstart

Get a Commonwealth brain running for one project in a couple of minutes. This is the
from-source path — no published npm package or committed `vendor/` bundle required; you build
the CLI locally and it just works.

## Prerequisites

- **Node ≥ 22** and **pnpm** (`corepack enable` gives you pnpm).
- **git** on your `PATH` (a brain _is_ a git repo).
- Optionally, the `claude` CLI if you want automatic session capture via the plugin.

## 1. Build the CLI

```bash
git clone https://github.com/kristoffeys/commonwealth.git
cd commonwealth
pnpm install
pnpm build          # build every package (tsup)
pnpm link-cli       # put `commonwealth` on your PATH → ~/.local/bin/commonwealth
```

`pnpm link-cli` writes a tiny wrapper that runs the built CLI from this checkout, so every
`commonwealth <verb>` below works. Make sure `~/.local/bin` is on your `PATH`. Prefer not to
link? Every command also runs as `node /path/to/commonwealth/packages/cli/dist/index.js <verb>`.

## 2. Initialize a brain for your project

From the project you want a brain for:

```bash
cd ~/work/my-project
commonwealth init
```

One idempotent command does the whole setup: creates a brain repo (a separate git repo under
`~/.commonwealth/brains/<project>-<hash>`), registers this project → that brain, seeds it by
mining your git history / ADRs / agent config into the review queue, installs the Commonwealth
plugin (MCP + session hooks), starts the sync daemon, and ensures your per-user scope config
exists. Re-run it anytime — it only does what's still missing. See the flags in
`commonwealth init --help` (e.g. `--yes`, `--no-daemon`, `--no-seed`, `--brain <dir>`).

## 3. Use it

- **In a Claude Code session** in this project, the plugin injects relevant team-brain context
  at session start and captures durable knowledge at session end (subject to the scope + curation
  gates). Ask it something your project already knows.
- **From the CLI**:

  ```bash
  commonwealth status        # review queue + sync-daemon state
  commonwealth health        # freshness/trust score (stale / unverified / orphaned counts)
  commonwealth recall <q>    # search the brain
  commonwealth pending       # notes awaiting review (when autoPromote is off)
  commonwealth promote --all # approve staged notes into canon
  ```

The MCP server also exposes `search`, `read`, `remember`, `list-work-state`, and `who-is` to any
MCP client.

## What just happened

- Your notes are **plain markdown** in the brain repo — the source of truth. Any index/DB is
  derived and rebuildable (ADR-0003/0005).
- Captured knowledge passes the **scope + dedup + secret gates** before it lands. By default
  (`autoPromote`) it goes straight to canon; set the flag off to require manual review.

Next: [Self-host guide](./06-self-host.md) — share a brain across a team with a git remote.
