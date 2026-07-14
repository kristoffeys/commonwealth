# Quickstart

Get a Commonwealth brain running for one project in a couple of minutes, from npm.

## Prerequisites

- **Node ≥ 22** and **git** on your `PATH` (a brain _is_ a git repo).
- Optionally, the `claude` CLI, the `codex` CLI, or both for agent integration.

## 0. Try it with no setup (optional)

```bash
npx @cmnwlth/cli demo
```

Scaffolds a throwaway brain for a fictional team and answers questions whose answers live only in
its notes, then cleans up after itself (`--keep` to poke around the files first).

## 1. Install the CLI

```bash
npm i -g @cmnwlth/cli      # or run any command with: npx @cmnwlth/cli <command>
```

## 2. Initialize a brain for your project

From the project you want a brain for:

```bash
cd ~/work/my-project
commonwealth init
```

One idempotent command does the whole setup: creates a brain repo (a separate git repo under
`~/.commonwealth/brains/<project>`), registers this project → that brain, seeds it by mining your
git history / ADRs / agent config into the review queue, installs the Commonwealth plugin (MCP +
host-specific lifecycle hooks; Codex also receives an `AGENTS.md` canon slice), starts the sync
daemon, and
ensures your per-user scope config exists. Re-run it anytime — it only does what's still missing.
See the flags in `commonwealth init --help` (e.g.
`--yes`, `--agent codex`, `--no-daemon`, `--no-seed`, `--brain <dir>`, `--remote <url>`).

The default agent target is `claude`. Choose Codex or install both integrations with:

```bash
commonwealth init --agent codex
commonwealth init --agent both
```

Prefer to install a plugin directly (the repo is a marketplace both clients understand)?

```bash
claude plugin marketplace add kristoffeys/commonwealth
claude plugin install commonwealth@commonwealth

codex plugin marketplace add kristoffeys/commonwealth
codex plugin add commonwealth@commonwealth
```

After installing or updating in Codex, run `/hooks`, review the Commonwealth command hooks, and
trust their current hash. Codex skips unreviewed plugin hooks. The MCP tools do not need this hook
approval.

## 3. Use it

- **In a Claude Code session** in this project, the plugin injects relevant team-brain context at
  session start and captures durable knowledge at session end (subject to the scope + curation
  gates). Ask it something your project already knows.
- **In Codex**, the plugin exposes the same MCP read/write tools, injects context at session and
  prompt boundaries, captures before compaction, and performs throttled capture at `Stop`. Codex
  `Stop` means **one agent turn completed**, not that the session ended. Onboarding also emits the
  project's canon slice into `AGENTS.md`.
- **From the CLI**:

  ```bash
  commonwealth status        # review queue + sync-daemon state
  commonwealth recall <q>    # search the brain
  commonwealth ask <q>       # a cited answer synthesized from the brain
  commonwealth health        # freshness/trust score (stale / unverified / orphaned counts)
  commonwealth pending       # notes awaiting review (when autoPromote is off)
  commonwealth promote --all # approve staged notes into canon
  ```

The MCP server also exposes `search`, `read`, `remember`, `list-work-state`, and `who-is` to any
MCP client.

## What just happened

- Your notes are **plain markdown** in the brain repo — the source of truth. Any index/DB is
  derived and rebuildable.
- Captured knowledge passes the **scope + dedup + secret gates** before it lands. By default
  (`autoPromote`) it goes straight to canon; set the flag off to require manual review.
- Out-of-scope projects inject nothing and never send their transcript to either host's recursive
  extractor. Codex capture uses short command hooks plus a detached worker; Codex does not support
  asynchronous command hooks, so `async` hook configuration is intentionally not used.

Next: [Self-host guide](./06-self-host.md) — share a brain across a team with a git remote.
