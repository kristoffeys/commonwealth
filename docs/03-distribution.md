---
title: Distribution & auto-provisioning
type: reference
status: draft
updated: 2026-07-14
tags: [distribution, provisioning, claude-code, codex, open-source]
---

# Distribution & auto-provisioning

Commonwealth is delivered as one plugin payload with **Claude Code and Codex manifests**. Claude
Code teams can roll it out through managed settings; Codex users install it from the same
marketplace and explicitly trust its command hooks in `/hooks`. This is the "auto bridge": once
provisioned, either host pulls relevant context in and captures learnings back without anyone
running git by hand.

## The auto-provisioning chain

```
Team-managed settings (org policy)
        │  distributes
        ▼
Commonwealth agent plugin  ──▶  MCP server + host lifecycle hooks + brain registry
        │  on host startup in a project dir
        ▼
Registry maps cwd/project → brain repo
        │  clones/pulls if missing
        ▼
Sync daemon running  ──▶  SessionStart: pull + inject relevant context
                          Claude SessionEnd / Codex Stop: capture → staging
```

### 1. Distribute the plugin via managed settings

Claude Code supports **org-wide managed policy settings** (highest precedence in the config
hierarchy). Reference the Commonwealth plugin (from the plugin marketplace / this repo) in your
managed settings, and when a teammate's Claude Code reads the policy the plugin is present — no
manual install. See [`packages/plugin/README.md`](../packages/plugin/README.md) for the exact
`extraKnownMarketplaces` + `enabledPlugins` block.

_Semi-_ automatic: first run still needs the user authenticated to the brain's git remote (their
own GitHub/GitLab identity) — Commonwealth never holds org-wide write credentials. After that,
hands-off.

### 2. The plugin bundles everything needed

- **MCP server** — `search / read / remember / list-work-state / who-is` tools (and `ask`).
- **Lifecycle hooks** — both hosts load `SessionStart`, `UserPromptSubmit`, and `PreCompact`.
  Claude Code adds `SessionEnd`; Codex maps capture to throttled, turn-scoped `Stop`. Hooks are how
  "auto" actually happens; the harness runs them, not the model.
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

- **Claude Code and Codex plugin marketplaces** — the same payload contains both manifests and
  selects a host-valid hook file for each.
- **npm** — `@cmnwlth/cli` for setup/admin; the MCP server and hooks run `@cmnwlth/*` via `npx`.
- **GitHub** — the OSS home: source, issues, and roadmap.
- **Cross-agent fallback** — `commonwealth emit` writes brain context into files Cursor, Copilot,
  and Codex already read. Codex also has the live MCP and lifecycle integration.

See the [agent parity contract](./07-agent-parity.md) for the exact event mapping, diagnostics,
update behavior, and the one intentional lifecycle difference.
