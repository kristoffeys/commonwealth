# 16. A unified `commonwealth <verb>` CLI

- Status: Accepted
- Date: 2026-07-02
- Deciders: kristof (owner), Claude (orchestrator)
- Relates: [ADR-0002](0002-stack-and-layout.md), [ADR-0012](0012-mcp-distribution-via-plugin.md),
  [ADR-0014](0014-auto-promotion-default.md), issue #93

## Context

`commonwealth` only did `init`; every other action lived in a separate binary
(`commonwealth-curate`, `commonwealth-sync`, `commonwealth-seed`) that users were never meant
to invoke directly — in practice they ran `node packages/…/dist/index.js …` or re-ran
`commonwealth init --reseed` to change one thing. There was no first-class way to reseed the
right brain, flip a feature flag (e.g. `autoPromote`), check status, or promote from the queue
without shelling into internals. Overloading `init` with flags for everything is the wrong model.

## Decision

`commonwealth` becomes a **single dispatcher** with a verb per common action. Every verb resolves
the brain the way the MCP server and hooks do — `$COMMONWEALTH_BRAIN_DIR`, else the registry
against the cwd (ADR-0011) — so the user never passes `--dir` or reruns `init`.

Surface:

- `init` — onboarding (unchanged).
- `reseed [<repo>...] [--all]` — mine repo(s) into the mapped brain and capture (source per repo,
  ADR-0015). Composes `@cmnwlth/seed` + a `curate capture` delegation.
- `config <list | get <k> | set <k> <v>>` — read/set the brain's shared config (feature flags:
  `autoPromote`, `autoAdr`). Composes `@cmnwlth/core` config directly.
- `status` — review queue + sync-daemon state.
- `sync <start | stop | once>` — control/run the daemon.
- `pending` / `promote <id…|--all>` / `reject <id…>` — the curation review queue.
- `scope <show | allow | deny | check>` — the per-user capture scope.
- `recall <query>` — search the brain.

**Implementation split:** `reseed` and `config` are the only genuinely new logic and are composed
in `packages/cli/src/commands.ts` from core + seed. The rest **delegate** to the existing,
tested curate/sync binaries — which became registry-aware in #69, so spawning them with the
inherited cwd is enough to hit the mapped brain. This reuses battle-tested code instead of
reimplementing it, and keeps the sub-binaries as the single source of truth for that behavior.

## Consequences

- Users get a coherent, discoverable CLI (`commonwealth --help` lists everything) and stop
  re-running `init` or touching internal binaries. The two concrete gaps that motivated this —
  no way to reseed the *mapped* brain, and no way to toggle `autoPromote` without hand-editing
  `config.json` — are closed.
- The sub-binaries (`commonwealth-curate` etc.) remain for the plugin's vendored use and as the
  implementation the delegations call; they are not deprecated, just fronted.
- Delegation spawns a child `node` per call — negligible for interactive use.
- Follow-ups (not in this ADR): `reseed --review` as a one-shot (currently: `config set
  autoPromote false` first), and native (non-spawn) implementations if startup latency matters.
