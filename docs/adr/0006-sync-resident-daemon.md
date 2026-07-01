# 6. Sync architecture: resident daemon

- Status: Accepted
- Date: 2026-07-01
- Deciders: kristof (owner), Claude (orchestrator)
- Relates: [architecture §2c, Components](../01-architecture.md), GitHub issues #6, #7, #8

## Context

M2 makes the brain multiplayer: local working copies must converge with a git remote,
and same-file edits must serialize without data loss. Two shapes were considered: a lean
sync library + CLI invoked by Claude Code hooks (no resident process), or a long-lived
per-machine daemon that watches and continuously syncs.

## Decision

**A resident, per-machine daemon** (`@commonwealth/sync`, bin `commonwealth-sync`).

- Watches each registered brain working copy for filesystem changes and, on change,
  commits and pushes.
- Runs a periodic pull loop so inbound teammate changes land continuously — not only at
  session boundaries. This enables real-time background propagation, the differentiator
  over hook-only sync.
- Owns the **write queue**: all git mutations run through one in-process serial queue
  (acquire → rebase → apply → push → retry), so concurrent changes never race (#7).
- On a genuine same-file conflict, **never overwrites**: writes both versions as sibling
  notes and records a conflict marker for review (#8).
- After every pull, rebuilds the derived index and regenerates `COMMONWEALTH.md`/`INDEX.md`.

The sync **engine** (pure-ish functions: `syncOnce`, `commitChange`, the queue, conflict
resolution) is factored out from the long-running watcher so it is unit-testable against
temp git repos (a bare remote + two clones) without running the daemon.

## Consequences

- Real-time cross-session propagation; the daemon is the natural host for later
  capture/curate hooks (M3) too.
- More moving parts than a library: process lifecycle (start/stop/status via PID file),
  a filesystem watcher, a poll loop. Mitigated by keeping all correctness-critical logic
  in the testable engine and treating the daemon as a thin runner.
- Claude Code hooks (M4) still exist but become thin — they can nudge the daemon (or fall
  back to a one-shot `commonwealth-sync sync`) rather than owning sync logic.

## Alternatives considered

- **Lean sync library + CLI invoked by hooks** — simpler and fully testable, but only
  syncs at session boundaries; no continuous background propagation. Rejected in favor of
  the real-time experience, accepting the added lifecycle complexity.
- **CRDT / custom sync protocol** — off-git, conflicts with the ownership thesis
  (ADR-0003). Rejected.
