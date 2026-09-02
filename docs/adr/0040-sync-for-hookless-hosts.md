# 40. The MCP server syncs for itself on hosts without our lifecycle hooks

- Status: Accepted
- Date: 2026-09-02
- Deciders: kristof (owner); Claude (orchestrator, proposer)
- Amends: [ADR-0032](0032-daemonless-lifecycle-sync.md) — the lifecycle hooks stay the syncer for
  Claude Code and Codex; this gives a **second** component the same responsibility on hosts that
  have no lifecycle to hang it on. ADR-0032 is not superseded: its premise ("the reliable component
  owns sync") is what this extends, on hosts where the hooks are not present at all.
- Relates: [ADR-0003](0003-concurrency-model.md) (union-merge is why uncoordinated pushes are safe —
  the load-bearing assumption here), [ADR-0008](0008-curation-locality.md) (`staging/` is per-user
  and never synced — which is why only a promoted note is publishable),
  [ADR-0012](0012-mcp-distribution-via-plugin.md) (the plugin that carries the MCP declaration this
  flag lives in), [ADR-0019](0019-access-model-clone-on-demand.md), #290, #219, #152, the F7
  parity overclaim in #276/#280

> The mechanism is an idea harvested from [openhuman](https://github.com/tinyhumansai/openhuman)
> (GPL-3.0 — idea only, no code, names, or prose reused): a tool server that persists to git should
> publish on the write itself and refresh on startup, rather than relying on the host to do it.
> Commonwealth's version is written from that description in Commonwealth's own vocabulary.

## Context

ADR-0032 folded sync into the session lifecycle hooks and the MCP server was left with none of it:
it never commits and never pushes. That is coherent as long as every host runs our hooks. Claude
Code and Codex do. **Nothing else does.**

Proven by driving the published `@cmnwlth/mcp@0.4.0` over raw stdio against a throwaway brain,
outside Claude Code (#290): a note written through the `remember` tool is created as an **untracked
working-tree file that never reaches a teammate** — while the tool answers `Remembered "…"`. The
user is told the note is in the team brain. It is on one laptop, uncommitted, invisible to `git`
until someone happens to run a sync.

This is the worst failure shape we ship: silent, on the **write** path, in the exact feature the
product is named for. It affects Claude Desktop's Chat tab, any bare MCP client, and any
`.mcp.json` / `npx @cmnwlth/mcp` wiring without the plugin's hooks. It is the blocking prerequisite
for Claude Desktop distribution — an extension whose notes never leave the laptop is worse than no
extension, because it looks like it works.

Two things were wrong, and only one of them is "sync":

1. **Nothing published the write.** Structural: no component with sync responsibility was running.
2. **The tool claimed success anyway.** A conflation of "written" with "published" that we would
   have to fix even if publishing were impossible on that host.

## Decision

**The MCP server owns sync when the host does not: pull-on-start, commit-and-push-on-write,
flag-gated, defaulting ON.**

1. **The engine is reused, not reimplemented.** `packages/mcp/src/sync.ts` drives
   `@cmnwlth/sync`'s `syncOnce` (via `syncOnceWithRetry`) in-process through **one shared**
   `SyncEngine`. `@cmnwlth/sync` grows a library entry (`src/lib.ts`, mirroring the CLI/library
   split `@cmnwlth/curate` already made) so the engine can be imported without executing the CLI.
   Zero git logic is duplicated; the secret scrub, sibling conflict resolution, derived-file
   regeneration, and `sync.lock` all come along unchanged.

2. **Two triggers, both edge-driven, no resident anything.** *Server start* → one bounded pull.
   *A note landing in canon* → one bounded commit+push. There is no timer, no watcher, no PID file,
   no background loop, and no state that outlives the process. See "Why this is not the daemon
   coming back" below.

3. **The flag is `COMMONWEALTH_MCP_SYNC`, and it defaults to server-owned.** `off` / `0` / `false`
   / `host` hands sync to the host; unset or anything else means the server syncs. Our own plugin
   sets `COMMONWEALTH_MCP_SYNC=off` in `packages/plugin/.mcp.json` (read by both the
   `.claude-plugin` and `.codex-plugin` manifests), so **Claude Code and Codex behaviour is
   unchanged** — same tool text, same untouched working tree, same hook-driven sync.

   **An unknown host fails toward publishing.** This is the whole decision, so it is worth being
   explicit about the asymmetry: defaulting to `host` and being wrong means a teammate's note is
   silently lost — the bug we are here to kill, now shipped as an intentional default. Defaulting
   to `server` and being wrong means one extra idempotent git pass on a host that also syncs; the
   cross-process `sync.lock` serializes it, `syncOnce` is a no-op when there is nothing to do, and
   ADR-0003's union-merge makes the redundant push safe. One of those is data loss and the other is
   a wasted second.

4. **Only a promoted note triggers a pass.** `staging/` is gitignored and per-user by design
   (ADR-0008), so a staged note is *unpublishable* until promoted, and a rejected one wrote nothing.
   Running a pass for either would be a pointless commit — ADR-0032 §2's "a zero-note session never
   syncs", applied to the write path. The staged answer instead says outright that the review queue
   never syncs, so "staged" cannot be misread as "shared".

5. **`remember` reports the truth, per outcome.** The tool text now states whether the note reached
   the remote, and `structuredContent.sync` carries `{ status, published }` so an agent can branch
   on it without parsing prose. Honest failure modes, all of which keep the note on disk:
   - **published** — committed and pushed.
   - **committed, no remote** — says so, and how to add one. A local-only brain is a legitimate
     configuration, not an error, but it must never read as "shared".
   - **deferred** — a live peer held `sync.lock`; nothing was done, and the next pass flushes it.
   - **timed-out** — the cap tripped; the pass continues detached and the user is told it may not
     be shared yet.
   - **failed** — git refused (offline, no credentials, no remote access, rejected push). The note
     is committed locally, the next sync retries, and the user is told their team cannot see it yet.

   A withheld secret is named explicitly in every branch where the engine reports one (#16, #98):
   silently dropping a note is the same class of bug as silently not publishing it.

6. **Pull-on-start is bounded and fails open.** 5s (ADR-0032 §3's SessionStart cap, same
   reasoning), then the server connects anyway and the pass keeps running detached. The failure
   mode is "serving slightly stale notes", never "the server refuses to start". The publish cap is
   longer (20s) because a user is waiting on a truthful answer and a cold first push is not fast —
   still bounded, so a wedged remote can never hang a tool call.

### Ordering against a concurrent Claude Code session

Both syncers converge on the same primitives, which is exactly why this is safe to duplicate:

- **Cross-process:** the `sync.lock` in `@cmnwlth/core` is the arbiter. If a hook-driven
  `commonwealth-sync sync` (or the opt-in daemon) holds it, our pass retries with ADR-0032's
  bounded linear backoff and, if the budget is exhausted, reports `deferred` rather than racing its
  git operations. The reverse holds identically: the hook pass sees `skippedLocked` and retries.
  Neither can interleave commits, rebases, or pushes with the other.
- **In-process:** `pullOnStart` and every `publish` share one `SyncEngine`, so its `SerialQueue`
  orders them. A startup pull and a `remember` arriving together queue; they do not race.
- **Cross-machine:** unchanged from ADR-0032 — git's atomic ref update at the remote decides, the
  loser rebases, and same-file collisions resolve as siblings. Atomic one-fact-per-file notes with
  collision-proof ids (ADR-0003) are what make two uncoordinated pushers a non-event.

We deliberately do **not** replicate ADR-0032 §4's "stand down if a daemon owns the brain".
Standing down would mean answering "did this reach my team?" with "eventually, probably" on the one
path where the user is waiting for a definite answer. The lock already makes contention correct,
and a lost race degrades to an honest `deferred`.

### Why this is not the daemon coming back

ADR-0006's daemon failed because it was a **long-lived process with persistent state that rotted
silently**: dead daemons, stale paths pointing at pre-split brains, zombies watching deleted
directories, launchd services nobody noticed had stopped. Every one of those failures was a
property of *residency*, not of git.

This has none of it. Sync happens only inside a request the server is already handling, in the
server's own process, driven by an edge (start, write). Nothing polls; nothing is scheduled;
nothing needs installing, supervising, or stopping; there is no PID file and no service. If the MCP
server is not running, there is nothing to rot — and if it is running, the user is actively using
it. It is ADR-0032's shape (sync at the boundaries of work, driven by the component that is
reliably alive when work happens) transplanted to a host whose only boundaries are "the tool
server started" and "a tool wrote something".

## Consequences

- The multiplayer promise holds on hosts we do not control. A note written from Claude Desktop's
  Chat tab or any bare MCP client is committed and pushed before the tool answers, and the answer
  says whether it actually shipped. #290's silent-loss class is designed out rather than documented.
- Claude Desktop distribution is unblocked (#219, #152 depend on this being true).
- Claude Code and Codex are untouched: `COMMONWEALTH_MCP_SYNC=off` in the plugin's MCP declaration
  keeps the pre-ADR-0040 write path byte-identical, and a test pins that response text.
- The write path can now cost a network round trip on a hookless host — a `remember` is slower
  there, by design: the alternative is answering faster and lying. Read tools are unaffected.
- Server startup can now cost up to 5s on a hookless host. Bounded and fail-open, but it is a real
  cost paid on every server start, including cold `npx` starts.
- `@cmnwlth/sync` becomes an importable library (`main` → `dist/lib.js`, the CLI stays on `bin`).
  Its runtime dependency closure — including `chokidar`, which only the unexported daemon uses — is
  now installed alongside `@cmnwlth/mcp`. Trimming that is a follow-up, not a blocker.
- Two components now have sync responsibility, and a reviewer must keep the flag in mind when
  touching either. That is the honest cost of amending ADR-0032, and the reason the default is
  argued explicitly above rather than left to taste.
- Still deliberately out of scope: mid-session inbound freshness on a hookless host (a teammate's
  note arriving *during* a Desktop conversation still needs a server restart, ADR-0032 §7's
  throttled-pull follow-up), automatic capture without hooks (a hookless host only ever writes what
  it is explicitly told to remember — now stated as a contract in `docs/07-agent-parity.md`), and
  clone-on-demand at MCP startup (ADR-0019 still runs from the CLI/hooks).

## Alternatives considered

- **Default the flag OFF and let hookless hosts opt in.** Safest-looking, actually the most
  dangerous: the population that needs this most is the one that cannot configure it, and the
  failure is silent. Rejected — an unknown host must fail toward publishing.
- **Detect the host instead of flagging it.** MCP's `clientInfo` name is self-reported, unversioned,
  and says nothing about whether *our hooks* are installed — the thing we actually care about. A
  sniffing heuristic would be wrong in both directions and untestable. Rejected in favour of an
  explicit env var set by the one component that knows the answer: our own plugin config.
- **Shell out to the `commonwealth-sync` binary (as the hooks do).** Consistent with ADR-0026, but
  it adds process-spawn latency and an `npx`-resolution failure mode inside a user-facing tool call,
  and buys nothing: the server is already a Node process that can import the engine and share its
  in-process queue. Rejected.
- **Sync on every tool call (or on a timer inside the server).** Turns a request-scoped edge trigger
  back into a poll loop with residency — the failure mode ADR-0032 exists to kill. Rejected.
- **Fire the publish and answer immediately (fire-and-forget).** Faster, and re-introduces the exact
  lie: the tool would once again say "remembered" without knowing whether it shipped. Rejected; the
  bounded wait is the price of a truthful answer.
- **Leave the code alone and document the limitation.** Considered seriously, because it is honest
  and cheap. Rejected: a documented silent data loss is still silent to the user typing into Claude
  Desktop, and "your notes stay on one laptop" is not a product.
