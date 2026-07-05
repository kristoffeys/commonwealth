# 2. Implementation stack: TypeScript + Node + pnpm monorepo

- Status: Accepted
- Date: 2026-07-01
- Deciders: kristof (owner), Claude (orchestrator)
- Relates: GitHub project "Commonwealth — Build"

## Context

Commonwealth ships several components (see [architecture](../01-architecture.md)): a core
library, an MCP server, a CLI, a sync daemon, a Claude Code plugin, and a curation
agent. We need one stack that covers all of them, integrates natively with the Claude
Code ecosystem, and lets a small team move fast.

## Decision

**TypeScript on Node.js, organized as a pnpm-workspaces monorepo.**

- Language: TypeScript (strict), ESM.
- Runtime: Node.js ≥ 22 LTS (dev on 24).
- Package manager / workspaces: **pnpm**.
- Test: **Vitest**. Lint/format: **ESLint + Prettier**. Build: **tsup** (esbuild).
- Key libs: `@modelcontextprotocol/sdk` (MCP), `gray-matter` (frontmatter), `zod`
  (schema validation), `better-sqlite3` (derived index + FTS5), `nanoid` (short ids),
  `github-slugger` (slugs), `simple-git` (git ops in the daemon).

Initial packages: `@cmnwlth/core` (schema, note IO, scaffold, index). MCP server, CLI,
daemon, and plugin are added as separate packages in later milestones.

## Consequences

- First-class MCP SDK and a JS-native Claude Code plugin story (hooks, marketplace) —
  the ecosystem we're distributing into.
- npm distribution; huge library ecosystem; likely aligns with Antenna's stack.
- Native dependency (`better-sqlite3`) needs prebuilt binaries/compilation — acceptable
  on supported platforms; revisit `node:sqlite` if it becomes a burden.
- We accept a Node runtime dependency rather than a single static binary. If
  distribution friction demands it later, we can ship a compiled binary (e.g. via a
  bundler/SEA) without changing the source language.

## Alternatives considered

- **Rust** (like Kage / basic-memory's core) — best single-binary distribution and
  performance, but slower to build, weaker MCP/plugin ecosystem fit, higher team-ramp
  cost. Performance is not our bottleneck (git + files are).
- **Python** — strong MCP SDK, but weaker fit for a Claude Code plugin and for shipping
  a CLI/daemon to non-Python users.
- **Go** — great daemons/binaries, but the MCP + Claude-Code-plugin ecosystem is
  JS/TS-centric.
