---
title: Distribution & auto-provisioning
type: reference
status: draft
updated: 2026-07-06
tags: [distribution, provisioning, claude-code, open-source]
---

# Distribution & auto-provisioning

Commonwealth is delivered as a **Claude Code plugin** that a team can roll out to everyone
through **managed settings** — so a new teammate gets the brain with no manual install. This is
the "auto bridge": once provisioned, sessions pull relevant context in and capture learnings back
without anyone running git by hand.

## The auto-provisioning chain

```
Team-managed settings (org policy)
        │  distributes
        ▼
Commonwealth Claude Code plugin  ──▶  MCP server + lifecycle hooks + brain registry
        │  on `claude` startup in a project dir
        ▼
Registry maps cwd/project → brain repo
        │  clones/pulls if missing
        ▼
Sync daemon running  ──▶  SessionStart: pull + inject relevant context
                          SessionEnd:   capture learnings → staging
```

### 1. Distribute the plugin via managed settings

Claude Code supports **org-wide managed policy settings** (highest precedence in the config
hierarchy). Reference the Commonwealth plugin (from the plugin marketplace / this repo) in your
managed settings, and when a teammate's Claude Code reads the policy the plugin is present — no
manual install. See [`packages/plugin/README.md`](https://github.com/kristoffeys/commonwealth/blob/main/packages/plugin/README.md) for the exact
`extraKnownMarketplaces` + `enabledPlugins` block.

_Semi-_ automatic: first run still needs the user authenticated to the brain's git remote (their
own GitHub/GitLab identity) — Commonwealth never holds org-wide write credentials. After that,
hands-off.

### 2. The plugin bundles everything needed

- **MCP server** — `search / read / remember / list-work-state / who-is` tools (and `ask`).
- **Lifecycle hooks** — `SessionStart` (pull + relevance-gated inject), `SessionEnd` (capture →
  staging). Hooks are how "auto" actually happens; the harness runs them, not the model.
- **Brain registry** — the map from project directory → brain repo.
- **`/commonwealth` commands** — `remember`, `decide`, `recall`, `ask`, `promote`, `status`.

### 3. The registry resolves the right brain automatically

On startup in a directory, resolution walks: a `.commonwealth/brain` marker file → a directory
that is itself a brain → the user registry (`prefix → brain` mappings) → `COMMONWEALTH_BRAIN_DIR`.
One global install therefore serves every repo, each session talking to the right brain. If the
brain isn't cloned locally yet and its registry mapping carries a remote, the daemon clones it on
demand on first use.

## Access control = git permissions

There is **no separate ACL layer**. A brain is a git repo; who can read or write it is exactly
who has access to that repo on the host (GitHub/GitLab teams, SSO, deploy keys). A clone or push
that fails for lack of access surfaces git's own error, and the session degrades to no-brain
rather than crashing. This keeps the security model boring, auditable, and aligned with tools
teams already trust.

## Distribution channels

- **Claude Code plugin marketplace** (`claude plugin marketplace add …`) — the primary path.
- **npm** — `@cmnwlth/cli` for setup/admin; the MCP server and hooks run `@cmnwlth/*` via `npx`.
- **GitHub** — the OSS home: source, issues, and roadmap.
- **Cross-agent** — `commonwealth emit` writes brain context into the files Cursor / Copilot /
  Codex already read, so mixed-tool teams share one brain (see the [self-host guide](./06-self-host.md)).
