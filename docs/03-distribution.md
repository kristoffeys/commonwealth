---
title: Distribution, Auto-Provisioning & Monetization
type: decision
status: draft
updated: 2026-07-01
tags: [distribution, provisioning, claude-code, open-source, monetization]
---

# Distribution, Auto-Provisioning & Monetization

The brief's hardest distribution ask: _our Claude company subscription
(semi-)automatically adds this second brain to each user's personal setup, and auto
pushes/fetches knowledge where it sees fit._ This is the "auto bridge" from the
architecture, delivered as a **Claude Code plugin** propagated through **team-managed
settings**.

## The auto-provisioning chain

```
Team-managed settings (org policy)
        │  distributes
        ▼
Commons Claude Code plugin  ──▶  installs: MCP server + lifecycle hooks + brain registry
        │  on `claude` startup in a project dir
        ▼
Registry maps cwd/project → brain repo(s)
        │  clones/pulls if missing
        ▼
Sync daemon running  ──▶  SessionStart: pull + inject relevant context
                          Stop/SessionEnd: capture learnings → staging
```

### 1. Distribute the plugin via managed settings

Claude Code supports **org-wide managed policy settings** (MDM/managed
`settings.json`, highest-precedence in the config hierarchy). The company subscription's
managed settings reference the **Commons plugin** (from our plugin marketplace / repo).
When a new teammate's Claude Code reads managed policy, the plugin is present — no manual
install. This is the "(semi-)automatic add to each user's setup."

_Semi-_ because first run still needs the user to authenticate to the git remote (their
GitHub identity) — we don't want to hold org-wide write creds. After that, hands-off.

### 2. Plugin bundles everything needed

The plugin ships:

- **MCP server registration** — `search / read / remember / work-state / people` tools.
- **Lifecycle hooks** — `SessionStart` (pull + relevance-gated inject), `Stop`/
  `SessionEnd` (capture → staging). Hooks are how "auto" actually happens; the harness
  runs them, not the model.
- **The brain registry** — the map from project → brain repo(s).
- **`/commons` skill/commands** — manual `remember`, `recall`, `promote`, `status`.

### 3. Registry resolves the right brain automatically

On startup in a directory, the plugin consults the registry:

- **Explicit:** a `.commons/brain` marker file in the project repo names its brain(s).
- **Convention:** map by git remote / org (e.g. `acme/*` → `acme-brain`).
- **Fallback:** the `org-brain` for cross-project knowledge.

If the brain isn't cloned locally yet, the daemon clones it (read perms checked against
the user's git identity — the brain's own repo permissions _are_ the access control; no
separate ACL system to build).

### 4. Daemon does the push/fetch "where it sees fit"

Per [architecture §3](01-architecture.md): pull + inject on session start, capture on
session end, curate + PR before canon, relevance-gate what gets surfaced. "Where it sees
fit" = the relevance gate + the curation agent, not a firehose.

## Access control = git permissions

We deliberately **don't build an ACL layer**. A brain is a git repo; who can read/write
is who has repo access on the host (GitHub teams, etc.). This keeps the security model
boring, auditable, and aligned with tools teams already trust — and it's a real
differentiator vs. cloud stores that reinvent permissions.

## Open source & monetization

**Open source the core** (the substrate, schema, daemon, MCP server, plugin, curation
agent). Rationale from [vision](00-vision.md): OSS is the distribution and trust wedge —
GBrain's 5k-stars-in-a-day proves the channel, and it's our credibility answer to
basic-memory (closed cloud) and Mem0 (open but not a product).

License: permissive (MIT/Apache-2.0) to match the cluster (GBrain MIT, Mem0 Apache,
Dust MIT) and maximize adoption. **Decision pending** — see roadmap open questions.

### What's free vs. paid (candidate model)

| Tier                           | Contents                                                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **OSS core (free, self-host)** | Substrate, schema, daemon, MCP server, plugin, basic curation. BYO git remote. The whole thing works with zero vendor.                                                                                 |
| **Hosted / Team (paid)**       | Managed remotes + daemon, hosted curation agent (no self-run cron), team feed/analytics, SSO, relevance-gate tuning, secret scanning. Convenience over lock-in — you can always eject to your own git. |
| **SOW-diff (the wedge)**       | The acute, monetizable product that rides the same substrate: read existing tools → structured memory → surfaced insight → drafted action. Land here on margin; expand to the brain.                   |

**Anti-lock-in as a feature:** because the source of truth is always your git repo, the
paid tier competes on convenience, not captivity. This is the explicit counter to the
"Anthropic eats the base case" risk — be the portable, cross-agent layer.

## Distribution channels

- **Claude Code plugin marketplace** (`/plugin marketplace add ...`) — primary, rides
  the Claude Code wave like Kage/Mem0/Cognee do.
- **GitHub repo + Projects** — OSS home, issues, roadmap, community.
- **Antenna dogfood** — the proof case and first reference customer.
- Cross-agent MCP (Codex/Cursor/Gemini CLI) later — the portability story.

## Open questions

- Managed-settings mechanism specifics for the current Claude Code version (verify the
  exact managed-policy plugin-distribution path before committing).
- Git identity bootstrap: smoothest way to get each teammate authenticated to the remote
  with least friction (device flow? org SSO to GitHub?).
- Hosted daemon multi-tenancy vs. per-user daemon — where does the curation cron run for
  paying teams?
