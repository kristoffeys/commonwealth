# 12. MCP distribution via the plugin at user scope

- Status: Accepted
- Date: 2026-07-01
- Deciders: kristof (owner), Claude (orchestrator)
- Relates: [ADR-0006](0006-sync-resident-daemon.md), [ADR-0011](0011-brain-wiring-global-registry.md),
  [distribution](../03-distribution.md), issue #14

## Context

`commonwealth init` used to register the MCP server with a raw `claude mcp add commonwealth …`
(no `--scope`). That has two defects:

1. **Local scope.** Without `--scope`, `claude mcp add` defaults to LOCAL scope — the
   registration is private to the single directory `init` ran in and is invisible to `/mcp` in
   any other session. A team-brain that only works in one folder is useless.
2. **A pinned brain.** The registration baked a STATIC `COMMONWEALTH_BRAIN_DIR=<dir>` into its
   env, so every repo that shared the one registration would talk to one brain — defeating the
   per-repo routing the registry (ADR-0011) exists to provide.

The plugin (`packages/plugin`) already declares the `commonwealth-brain` MCP server and the
`SessionStart`/`SessionEnd` hooks. A Claude Code plugin installs at USER scope (global) and its
`SessionStart` hook receives the real session cwd on stdin, which the MCP server process cannot
see reliably. That is exactly the shape per-repo routing needs.

## Decision

1. **The MCP is distributed via the plugin, installed at USER scope through a repo marketplace.**
   The repo root ships `.claude-plugin/marketplace.json` declaring the `commonwealth` plugin at
   `./packages/plugin`. Teammates run `claude plugin marketplace add kristoffeys/commonwealth`
   then `claude plugin install commonwealth@commonwealth`; the plugin's `commonwealth-brain`
   server is then available globally in every session.
2. **Per-repo brain routing is dynamic, from two independent resolvers:**
   - the **SessionStart hook** resolves the real session cwd → the brain via the registry and
     injects context (it can see cwd; the server cannot); and
   - the **MCP server** resolves its own brain via `@commonwealth/core.resolveBrainDir(cwd)` at
     startup (`packages/mcp/src/brain.ts`), so the tools (`search`/`read`/`remember`) hit the
     correct brain. An explicit `COMMONWEALTH_BRAIN_DIR` still wins (the plugin/daemon may set
     it); otherwise the registry maps cwd → brain; a null result degrades to cwd (never crash).
3. **The raw local-scope `claude mcp add` is REMOVED.** `init`'s `OnboardDeps.registerMcp(brainDir)`
   is replaced by `installPlugin()`: it refreshes the vendored bundle, adds the marketplace
   (idempotent — skips if a `commonwealth` marketplace exists), installs the plugin (idempotent —
   skips if already installed), and cleans up any STALE raw `commonwealth` MCP registration
   (`claude mcp remove commonwealth -s local`) so it can't shadow the plugin's server. Every
   spawn is best-effort and never throws; a missing `claude` degrades to a skipped note.

## Consequences

- The MCP is global — available in every session, not just the install dir. `/mcp` shows it
  everywhere.
- One install serves every repo; the brain is chosen per session by the hook and per process by
  the server, both via the registry. No brain is pinned into the registration.
- Teammates install with two commands (`claude plugin marketplace add kristoffeys/commonwealth`
  and `claude plugin install commonwealth@commonwealth`), or an admin auto-provisions the
  marketplace + plugin through managed settings (distribution doc §1).
- `init` no longer needs the brain dir for the MCP step; the step is idempotent and safe to re-run.
- The `--no-plugin` flag gates the step (`--no-mcp` kept as a backward-compatible alias).

## Alternatives considered

- **User-scope raw `claude mcp add -s user`** — rejected: it fixes the visibility problem but
  still can't route per-repo (one registration, one env), and it skips the SessionStart/SessionEnd
  hooks that make the auto-bridge work. The plugin bundles both the server AND the hooks.
- **Keep local scope, register once per project** — rejected: N registrations to manage, each
  pinned to one brain, none visible across sessions.

Supersedes nothing (it corrects an implementation detail of the distribution approach; ADR-0006
and the distribution doc already named the plugin as the delivery vehicle).
