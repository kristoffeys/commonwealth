# 32. Sync moves from a resident daemon to the session lifecycle; the daemon becomes an opt-in profile

- Status: Accepted
- Date: 2026-07-16
- Deciders: kristof (owner)
- Supersedes: [ADR-0006](0006-sync-resident-daemon.md) (the resident-daemon-as-default decision) and
  the always-on-daemon assumption baked into the M2 roadmap
- Relates: [ADR-0003](0003-concurrency-model.md) (union-merge is why uncoordinated pushes are safe),
  [ADR-0026](0026-portable-plugin-runtime-fallback.md) (vendored → npx runtime resolution — reused
  for the sync child), [ADR-0027](0027-host-neutral-extraction-runtime.md) /
  [ADR-0028](0028-codex-turn-boundary-lifecycle.md) (the lifecycle hook points this hangs on),
  #240, #234 (index freshness — the required companion), #218 (live push channels — the future),
  #194 (throttle pattern), incident log in #210/#211/#222

## Context

Sync was the job of a **resident daemon** (ADR-0006): a per-machine process that watches each brain
working copy, commits + pushes on change, and polls for inbound teammate changes. In practice it was
the single least reliable link in the chain, and every failure was **silent**:

- Silent death (2026-07-08): notes sat uncommitted for a week.
- A launchd service still pointing at a pre-split brain path.
- A zombie daemon watching a directory that no longer existed since Jul 1.
- Daemons started from sandboxed shells dying with the shell.

The lifecycle **hooks**, by contrast, survived every one of those incidents — they run when Claude
Code runs, own no long-lived state, and have nothing to rot. Yet the hooks did **zero** git sync:
SessionStart only injected context, and the capture worker wrote note files but never committed
them. So the reliable component did no syncing and the unreliable one did all of it.

For non-dev onboarding ("install the plugin → it just works") a resident-service requirement is a
hard blocker: `service install`, permission prompts, and a process to babysit. And the daemon's
original justification — serialize concurrent writes — is redundant with the concurrency design
(ADR-0003): atomic one-fact-per-file notes with collision-proof ids **union-merge**, so an
uncoordinated commit/pull-rebase/push from each session is safe without any daemon-side queue.

## Decision

**Fold sync into the session lifecycle. Keep the sync engine; demote the daemon to an opt-in
profile.** The engine from ADR-0006 (`SyncEngine.syncOnce`: commit → pull --rebase --autostash →
resolve conflicts as siblings → rebuild derived → push, with the pre-commit secret scrub and the
cross-process `sync.lock`) is **unchanged**. Only *what drives it* changes.

1. **The hooks drive the engine as a library, via the same runtime resolution the curate child
   uses** (ADR-0026: vendored `vendor/sync/index.js` → `npx -y @cmnwlth/sync` fallback). The plugin
   never forks git logic; it shells the sync package's one-shot `sync` subcommand with `--dir
   <brain>`. `resolveSyncRuntime` mirrors `resolveCurateRuntime` exactly.

2. **Capture worker syncs after a non-empty capture.** In the already-detached SessionEnd/PreCompact
   worker, after staging/promoting ≥1 note, run sync-once (hard 60s cap). A zero-note session never
   syncs — no pointless empty commit. On timeout/failure the worker does **not** throw: the notes are
   safely committed locally, the receipt says "sync deferred — will flush next session", and the next
   SessionStart flushes them. The "process died so notes never committed" failure class disappears
   structurally, because sync now happens exactly when there is something to sync.

3. **SessionStart pulls first, hard-capped at 5s, fail-open.** Before injecting context, run
   sync-once; on timeout/failure inject slightly-stale context AND spawn the sync **detached** so it
   finishes in the background. Because sync-once inherently flushes debt (commit pending → pull →
   push), this also recovers any commits a prior failed/offline session-end left unpushed —
   self-healing with zero persistent state.

4. **Daemon arbitration.** If a live sync daemon owns the brain (`.commonwealth/sync.pid` names a
   live pid), the lifecycle hooks **skip sync entirely** — the daemon already converges continuously.
   If both fire anyway, the existing cross-process `sync.lock` protects the repo: the loser is
   reported as `skippedLocked` and retries with bounded linear backoff (`syncOnceWithRetry`) so two
   simultaneous session-ends both land in one round; if the retry budget is exhausted the loser
   defers to its next SessionStart debt-flush. No pass ever races another's git ops.

5. **Daemon becomes an opt-in profile, NOT deleted.** Headless/server installs, shared-machine
   brains, and high-frequency teams still want continuous background propagation; `commonwealth sync
   start` / the service commands remain. `doctor` and the health model are reframed accordingly
   (below).

6. **Health model.** Lifecycle sync (daemonless) is the healthy **default**: `doctor` reports "Sync:
   lifecycle (daemonless)" as OK when no daemon runs; a live daemon reports as the daemon profile; a
   stale daemon pidfile is a soft warning (lifecycle still covers it), no longer a hard failure. The
   real unhealthy signal is **sync debt** — uncommitted note files or unpushed commits — surfaced as
   a warning **with age** once older than 24h (lifecycle sync should have flushed it: offline, or a
   push that keeps failing).

7. **UserPromptSubmit does NOT sync in v1.** Mid-session inbound freshness (a throttled pull on the
   #194 pattern) and live push (#218 channels) are deliberately out of scope here — teammates' notes
   arriving at the next SessionStart matches the real cadence. Filed as follow-ups.

## Consequences

- The reliable component (hooks) now owns sync; the unreliable one (a resident process) is optional.
  The silent-death, stale-path, and shell-death failure classes are designed out for the default user.
- Zero-service onboarding: install the plugin and sync happens at session boundaries. No
  `service install`, no permission prompt, nothing to babysit.
- Safety rests entirely on ADR-0003's union-merge, now exercised by uncoordinated per-session
  pushes. The `sync.lock` + bounded retry keeps even simultaneous session-ends on one machine
  correct; a genuine same-file conflict still resolves as siblings via the unchanged engine.
- Trade-off: no continuous background propagation by default — inbound teammate changes land at the
  next SessionStart, not in real time. Teams that need real-time opt into the daemon profile. This is
  the lean-library option ADR-0006 explicitly rejected; the incident history reversed the cost/benefit.
- Index freshness (#234, reconcile-on-read) is the required companion: with no daemon rebuilding the
  index on a poll loop, reads must reconcile the derived index themselves. Referenced, not solved here.

## Alternatives considered

- **Keep the daemon as default, just make it more robust** (supervise, heartbeat, self-restart) —
  adds still more moving parts to the component whose defining problem is that it rots silently, and
  does nothing for zero-service onboarding. Rejected.
- **Sync on UserPromptSubmit too (mid-session)** — more network chatter and a per-turn latency budget
  for marginal freshness gain; the session-boundary cadence already matches how teammates work.
  Deferred to a throttled follow-up.
- **Delete the daemon entirely** — loses the genuinely-useful continuous-propagation profile for
  headless/shared/high-frequency cases. Rejected in favor of demotion to opt-in.
