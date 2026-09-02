---
title: Test coverage matrix
---

# Test coverage matrix

The idea and convention below are harvested from [openhuman](https://github.com/tinyhumansai/openhuman)
(GPL-3.0) — description only, no code; see the `openhuman research must stay clean-room` decision
note in the brain. Implementation here is original.

This page maps every capability to the test file(s) that actually exercise it, so "is this
covered?" is a lookup instead of tribal knowledge. It is honest by design: a row marked ✅ means a
real test failed when the behavior was broken while writing this page, not that a file with a
plausible name exists. Where coverage is thin or absent, that is stated plainly, with why it
matters and — for anything only verifiable by hand — what an automated version would need.

**Convention (see `CLAUDE.md`):** a PR that changes a capability's behavior updates that
capability's row in this matrix in the same PR.

## Status vocabulary

| Symbol | Meaning |
|---|---|
| ✅ Full | Automated test(s) cover the happy path **and** at least one failure/edge path, exercising real behavior (real git, real filesystem, real child processes where relevant — not mocked away). |
| 🟡 Partial | Automated, but a specific gap is named in the Notes column. |
| ⚠️ Manual-by-necessity | Cannot be exercised by this suite without infrastructure it doesn't have (a second physical machine, a live external host). A human must verify it; what an automated version would need is stated. |
| ❌ Missing | Implemented with no automated test. |

Verified 2026-09-02 against `pnpm test`: **104 test files, 1122 tests, all green.**

## Concurrency-sensitive paths (CLAUDE.md definition-of-done)

These are the paths ADR-0003's "concurrent writes union-merge without conflict" claim actually
rests on. They get named individually because a silent regression here is the one that most
directly breaks the project's core pitch.

| Capability | Implementation | Test(s) | Status | Notes |
|---|---|---|---|---|
| Atomic note writes (no reader ever sees a partial file) | `packages/core/src/notes.ts` (`writeNote`: write to `.tmp`, publish via `fs.link`) | `packages/core/test/notes.test.ts` | ✅ Full | — |
| Id collision fails **closed**, never silently overwrites | `packages/core/src/notes.ts` (`fs.link` throws `EEXIST`, not `fs.rename`) | `packages/core/test/notes.test.ts` (`writeNote refuses to overwrite an existing note on an id collision (#101)`) | ✅ Full | — |
| Id collision-resistance (`ids.ts`) | `packages/core/src/ids.ts` (`makeNoteId`, 4-char random suffix, ~1.7M values) | `packages/core/test/concurrency.test.ts` (`makeNoteId uses a random suffix so repeated calls differ`) | 🟡 Partial | The test is a 50-call uniqueness spot-check, not a statistical collision-rate proof. Acceptable given the fail-closed backstop above, but note it's a sample, not a bound. |
| Two writers, same title+date, merge as a union with zero git conflict | `packages/core/src/notes.ts` + `ids.ts` | `packages/core/test/concurrency.test.ts` (`same title+date on two branches produce distinct files that merge cleanly`) | ✅ Full | Simulated via two git branches merged sequentially, not literally simultaneous processes — see the cross-cutting note below. |
| True simultaneous writers (real race, not turn-taking) | `packages/curate/src/capture.ts` (contributor person resolution; supersession) | `packages/curate/test/capture-autopromote.test.ts` (`converges concurrent name-only and email-backed first writes`, uses `Promise.all`), `packages/curate/test/capture-supersede-lock.test.ts` (`two concurrent captures superseding one target never disagree with disk`, uses `Promise.all`) | ✅ Full | The two places in the suite that fire two writers with genuine `Promise.all` concurrency rather than sequential turns. Everything else in this table is turn-taking simulation of the *outcome* of a race (see cross-cutting note). |
| Sync engine: single-writer lock serializes concurrent `syncOnce()` on one brain | `packages/sync/src/lock.ts`, `packages/sync/src/engine.ts` | `packages/sync/test/lock.test.ts`, `packages/sync/test/engine.test.ts` (`skips (no-op) when another live process holds the sync lock (#100)`), `packages/core/test/clone.test.ts` (`survives a concurrent race — both callers converge, neither corrupts`) | ✅ Full | This lock is the actual mechanism that makes same-machine concurrency safe — the design serializes rather than relying on atomic-everything. |
| Sync engine: crash recovery (stranded rebase from a killed process) | `packages/sync/src/engine.ts` | `packages/sync/test/engine.test.ts` (`recovers a rebase stranded by a prior crashed pass, then converges (#100)`) | ✅ Full | — |
| MCP-only sync races a hook-driven sync on one brain (ADR-0040) | `packages/mcp/src/sync.ts`, `packages/core/src/lock.ts` | `packages/mcp/test/sync.test.ts` (`defers while a concurrent hook sync holds the lock, and the note lands on the next pass`, `runs simultaneously with a hook sync without corrupting the repo or deadlocking`) | ✅ Full | Two components now sync the same brain (#290). The second test is one of the few genuine `Promise.all` races in the suite — two separate `SyncEngine` instances, so only the cross-process file lock orders them — and asserts convergence with no conflict markers in either teammate-visible note. |
| Conflict handling — sibling-file resolution (`packages/sync/src/conflict.ts`) | `packages/sync/src/conflict.ts` (`resolveConflictsAsSiblings`) | `packages/sync/test/conflict.test.ts` | ✅ Full | Only 2 tests, but both substantive: same-file conflict resolves to two sibling files with no markers, and a secret present during conflict resolution is never committed/pushed (#98). |
| Curation gate: scope (deny/allow routing before capture) | `packages/curate/src/scope.ts`, `packages/curate/src/capture.ts` | `packages/curate/test/scope.test.ts`, `packages/curate/test/capture-scope.test.ts` | ✅ Full | — |
| Curation gate: secret detection | `packages/core/src/secrets.ts`, `secrets-gitleaks.generated.ts` | `packages/core/test/secrets.test.ts`, `packages/core/test/secrets-gitleaks.test.ts`, `packages/curate/test/secrets.test.ts` (gate-level: title/tags/kind-specific fields, entropy opt-in) | ✅ Full | Gitleaks-derived patterns are tested against a benign corpus for false positives, not just true positives. |
| Curation gate: lexical dedup | `packages/curate/src/curate.ts` | `packages/curate/test/curate.test.ts` (`rejects a candidate near-identical to an existing canon note`, `stages only one of two near-identical candidates in a batch`) | ✅ Full | — |
| Curation gate: semantic dedup (ADR-0021) | `packages/curate/src/curate.ts` (embedding path) | `packages/curate/test/semantic-dedup.test.ts` | ✅ Full | Covers flag-off passthrough, flag-on rejection, no-vectors-yet fallback, and a true-negative (unrelated novel note still stages). |
| Staging → promote | `packages/curate/src/staging.ts`, `packages/curate/src/promote-pr.ts` | `packages/curate/test/staging.test.ts`, `packages/curate/test/promote-pr.test.ts` | 🟡 Partial | `staging.ts` itself has exactly one test (writes land under `staging/<dir>/`, stay out of canon). `promote-pr.ts` is thoroughly covered (branch/commit/push/PR body, partial-selection, post-merge reconciliation ADR-0008, closed-PR re-promote, secret scrub parity #98/#16, no-remote / no-`gh` graceful refusals). The thin spot is `staging.ts`'s own edge cases (e.g. re-staging an id already pending) rather than the promote flow. |
| Supersede semantics (`status` + `superseded_by`, never delete) | `packages/core/src/notes.ts` (`supersedeNote`/`overwriteNote`), `packages/curate/src/consolidate.ts`, `packages/curate/src/tombstone.ts` | `packages/core/test/notes.test.ts` (`marks a memory note superseded in place, keeping the file`), `packages/curate/test/consolidate.test.ts` (supersede-not-delete on near-duplicate consolidation, single-writer lock respected), `packages/curate/test/tombstone.test.ts` (reject-tombstones union-merge across teammates, corrupt-file isolation, idempotent re-reject) | ✅ Full | — |
| Supersession is single-writer on the capture path (#281) | `packages/curate/src/capture.ts` (`acquireSyncLock` around the ADR-0030 supersession loop) | `packages/curate/test/capture-supersede-lock.test.ts` (concurrent `Promise.all` supersessions of one target, contended-lock defer + persisted `supersession-deferred` receipt, lock released on the throwing path, no lock taken when there is nothing to supersede) | ✅ Full | `supersedeNote` is a read-modify-write of a pre-existing note, so it is the one capture write that atomic-one-fact-per-file does *not* protect. Both concurrency tests fail if the lock is removed. |
| Auto-promote flag (ADR-0014): default-on straight-to-canon vs. gated review queue | `packages/curate/src/capture.ts`, `packages/curate/src/graduate.ts` | `packages/curate/test/capture-autopromote.test.ts`, `packages/curate/test/graduate.test.ts` (`stays in staging even when the org-brain has autoPromote=true (manual review by default)`) | ✅ Full | — |

**Cross-cutting honesty note on "concurrency" tests:** most tests above simulate concurrency by
turn-taking — two git branches created and merged in sequence, or `syncOnce()` called on alice
then bob — rather than firing genuinely simultaneous processes. This is a reasonable choice for
most of them: the design's actual safety net for same-machine concurrency is the sync lock
(tested directly), and for cross-machine concurrency the real race is decided by git's own
atomic ref update at the remote (whoever pushes first wins; the loser's `syncOnce` sees a
rejected push and runs conflict resolution) — the sequential alice-then-bob shape in
`conflict.test.ts` and `sync/test/engine.test.ts` is what that race actually reduces to once one
push has landed, so it is faithful, not a shortcut. The one place a literal `Promise.all` race is
exercised is `capture-autopromote.test.ts`'s contributor-identity test, joined by
`capture-supersede-lock.test.ts`'s concurrent supersessions (#281). **What a stronger
automated test would need:** a fixture that spawns two real child processes against the same
brain directory with `Promise.all` and asserts convergence — most valuable for the id-collision
path (writing the *exact same* title+date+random-suffix collision is currently only reachable by
mocking `shortId()`, which no test does) and for the sync lock under true OS-level concurrent
`syncOnce()` calls rather than sequential ones.

## `packages/core`

| Capability | Test file(s) | Status | Notes |
|---|---|---|---|
| Note parse/serialize round-trip, unknown-key preservation (#81) | `notes.test.ts` | ✅ Full | — |
| Path containment (no escaping the brain dir, #76/#77) | `notes.test.ts` | ✅ Full | — |
| Malformed note isolation (one bad file doesn't fail `listNotes`, #80) | `notes.test.ts` | ✅ Full | — |
| Project provenance layout (`<project>/<kind>/`, ADR-0015) | `notes.test.ts` | ✅ Full | — |
| Derived-file detection (hub/MOC vs. user-owned README, ADR-0034) | `notes.test.ts` | ✅ Full | — |
| `ask` retrieval (citation-anchored, coverage signal, ADR-0020) | `ask.test.ts` | ✅ Full | — |
| Attribution / responsibility linking (ADR-0029) | `attribution.test.ts` | ✅ Full | — |
| Capture-coverage accounting | `capture-coverage.test.ts` | ✅ Full | — |
| Brain clone / ensure-cloned, incl. concurrent race | `clone.test.ts` | ✅ Full | — |
| Config IO, rule resolution | `config.test.ts`, `rule-resolution.test.ts`, `shared-rules.test.ts` | ✅ Full | — |
| Embeddings | `embed.test.ts`, `vectors.test.ts` | ✅ Full | — |
| Derived-index emit / rebuild | `emit.test.ts` | ✅ Full | — |
| Org-brain graduation policy | `graduate-policy.test.ts` | ✅ Full | — |
| `doctor`-style health checks | `health.test.ts` | ✅ Full | — |
| Derived SQLite index + hybrid (FTS5 + vector) search | `index-db.test.ts`, `hybrid-search.test.ts` | ✅ Full | — |
| MOC / map generation | `map.test.ts` | ✅ Full | — |
| Registry (brain path resolution), org-brain registry | `registry.test.ts`, `registry-orgbrain.test.ts` | ✅ Full | — |
| Project resolution | `projects.test.ts` | ✅ Full | — |
| Note source/provenance stamping | `source.test.ts` | ✅ Full | — |
| Status/summary reporting | `status.test.ts` | ✅ Full | — |
| `verify` (derived-vs-source consistency check) | `verify.test.ts` | ✅ Full | — |

## `packages/curate`

Gate-level rows are in the concurrency table above. Additional capabilities:

| Capability | Test file(s) | Status | Notes |
|---|---|---|---|
| Adopt (bring an external note into canon) | `adopt.test.ts` | ✅ Full | — |
| Auto-ADR proposal on decision-shaped captures | `autoadr.test.ts` | ✅ Full | — |
| Consolidate near-duplicate canon notes | `consolidate.test.ts` | ✅ Full | — |
| Context assembly for the curator | `context.test.ts` | ✅ Full | — |
| Contradiction detection (ADR-0033) | `contradiction.test.ts` | ✅ Full | — |
| Nearest-neighbor ranking | `neighbors.test.ts` | ✅ Full | — |
| Reclassify memory → decision (#265) | `reclassify.test.ts` | ✅ Full | — |
| Relevance scoring | `relevance.test.ts` | ✅ Full | — |
| Human review-queue listing | `review.test.ts` | ✅ Full | — |
| Verdict capture (per-candidate accept/reject bookkeeping) | `verdict-capture.test.ts` | ✅ Full | — |
| Smoke (built curate binary runs) | `smoke.test.ts` | ✅ Full | — |
| Project stamping on capture | `capture-project.test.ts` | ✅ Full | — |

## `packages/sync`

Lock, conflict, engine convergence, and secret-scrub rows are in the concurrency table above.
Additional:

| Capability | Test file(s) | Status | Notes |
|---|---|---|---|
| Git plumbing (commit, non-ASCII paths #99) | `git.test.ts` | ✅ Full | — |
| Daemon lifecycle (start/stop, single-instance guard #100, self-trigger avoidance) | `daemon.test.ts` | ✅ Full | Daemon itself is legacy per ADR-0032 (daemonless is now the default lifecycle) — see `packages/plugin` row below. Still exercised because the code path remains in the tree. |
| Derived-file formatting | `format.test.ts` | ✅ Full | — |
| Sync queue | `queue.test.ts` | ✅ Full | — |
| Push/pull retry policy | `retry.test.ts` | ✅ Full | — |
| Smoke (built sync binary runs) | `smoke.test.ts` | ✅ Full | — |

## `packages/mcp`

| Capability | Test file(s) | Status | Notes |
|---|---|---|---|
| Brain-dir resolution for the MCP server | `brain.test.ts` | ✅ Full | — |
| Prompt rendering + drift guard against `packages/plugin/commands/*.md` (#216) | `prompts.test.ts` | ✅ Full | — |
| Resource listing | `resources.test.ts` | ✅ Full | — |
| Server construction, tool registration, no-brain / corrupt-config error surfacing (#210) | `server.test.ts` | ✅ Full | — |
| Tool implementations (the six MCP tools) | `tools.test.ts` | ✅ Full | — |
| MCP-only sync on hookless hosts: publish-on-write, pull-on-start, flag default, honest failure reporting (#290, ADR-0040) | `sync.test.ts` | ✅ Full | Asserts **git state**, not file existence: the remembered note is tracked, the tree is clean, and a fresh clone of the remote has it. Failure paths covered: unreachable remote (committed locally + "publishing FAILED"), no remote at all, a wedged pass hitting the time cap, a staged note that can never publish, and lock contention. The flag-off case pins the pre-ADR-0040 response text byte-for-byte so Claude Code's write path cannot drift. |
| stdio protocol handshake against the **built** binary (lists tools over real stdio) | `smoke.test.ts` | ✅ Full | This is the deepest automated handshake test — real process, real MCP stdio transport. |
| Live handshake against an actual Claude Code / Codex client | — | ⚠️ Manual-by-necessity | No automated test drives a real Claude Code or Codex process against the MCP server; `smoke.test.ts` proves the wire protocol works, not that Claude Code's specific client behavior (tool-call formatting, prompt argument passing) matches. An automated version would need a scripted Claude Code CLI session (or the Codex equivalent) as a subprocess — out of reach for a unit/integration suite without a live model call. |

## `packages/cli`

| Capability | Test file(s) | Status | Notes |
|---|---|---|---|
| `add` | `add.test.ts` | ✅ Full | — |
| `ask` | `ask.test.ts` | ✅ Full | — |
| Capture logging | `capture-log.test.ts` | ✅ Full | — |
| `demo` (scripted recall walkthrough) | `demo.test.ts` | ✅ Full | — |
| Dependency checks | `deps.test.ts` | ✅ Full | — |
| History discovery / missed-capture analysis | `discover.test.ts` | ✅ Full | — |
| `doctor` | `doctor.test.ts` | ✅ Full | — |
| `emit` (derived-file regeneration CLI) | `emit.test.ts` | ✅ Full | — |
| Host integration (writing Claude Code / Codex config) | `host-integration.test.ts` | ✅ Full | — |
| `init` | `init.test.ts` | ✅ Full | — |
| Interactive onboarding wizard | `onboard.test.ts`, `wizard.test.ts` | ✅ Full | — |
| Org-brain commands | `org-brain.test.ts` | ✅ Full | — |
| Prompt templating | `prompt.test.ts` | ✅ Full | — |
| Registry commands | `registry.test.ts` | ✅ Full | — |
| Background service management | `service.test.ts` | ✅ Full | — |
| Statusline integration | `statusline.test.ts` | ✅ Full | — |
| `synthesize` | `synthesize.test.ts` | ✅ Full | — |
| `update` | `update.test.ts` | ✅ Full | — |
| `verify` CLI wrapper | `verify.test.ts` | ✅ Full | — |
| Smoke (built CLI binary runs) | `smoke.test.ts` | ✅ Full | — |
| Claude/Codex onboarding + update parity (#226) | `host-parity.e2e.test.ts` | ✅ Full | Genuine e2e: runs the real CLI against fixture host directories for both hosts. |

## `packages/seed`

| Capability | Test file(s) | Status | Notes |
|---|---|---|---|
| Config importer (seeding from an existing tool's config) | `config-importer.test.ts` | ✅ Full | — |
| Git-history mining for seed candidates | `git-miner.test.ts` | ✅ Full | — |
| Seed orchestration | `seed.test.ts` | ✅ Full | — |
| Smoke (built seed binary runs) | `smoke.test.ts` | ✅ Full | — |

## `packages/plugin` (the hook layer — Claude Code + Codex)

This is the layer most likely to look untested from file names alone, because the `hooks/*.mjs`
entrypoints are thin CLI wrappers. In fact the logic they wrap is unit-tested directly, and the
wrappers themselves are exercised as real subprocesses:

| Capability | Implementation | Test(s) | Status | Notes |
|---|---|---|---|---|
| Session lifecycle logic (start/prompt-submit injection, scope gate, corrupt-config surfacing #210) | `hooks/lib.mjs` | `test/lib.test.ts`, `test/realdeps.test.ts` | ✅ Full | `realdeps.test.ts` runs the *real* hook entrypoints as subprocesses with `DISABLE_HOOKS` toggled, a real curate binary over stdin, and a hard-killed wedged extraction child (#104) — not just the imported functions. |
| Transcript extraction (Claude + Codex schemas, oversized-transcript handling #84) | `hooks/extraction.mjs` | `test/extraction.test.ts`, `test/realdeps.test.ts` (multi-MB transcript via stdin not argv, #84) | ✅ Full | — |
| LLM classification of captured candidates (batched, fail-open) | `hooks/classify.mjs` | `test/classify.test.ts`, `test/curation-pipeline.test.ts` | ✅ Full | — |
| Contradiction guard (PreToolUse, ADR-0033) | `hooks/contradiction-guard.mjs` | `test/contradiction-guard.test.ts` | ✅ Full | — |
| Reclassify judge (fail-closed per row, #265) | `hooks/reclassify.mjs` | `test/reclassify.test.ts` | ✅ Full | — |
| Codex lifecycle adapter (event mapping, recursion guard, PreCompact/Stop throttling, #225) | `hooks/codex-hook.mjs` | `test/codex-hooks.test.ts` | ✅ Full | — |
| Detached capture worker (survives `/clear` teardown, #190) | `hooks/capture-worker.mjs` | `test/realdeps.test.ts` (`finishes its work after the launcher's process group is killed`) | ✅ Full | — |
| Daemonless lifecycle sync end-to-end (SessionEnd commits+pushes, offline-commit flush at next SessionStart, ADR-0032) | `hooks/session-end.mjs`, `hooks/session-start.mjs` | `test/lifecycle-sync.e2e.test.ts` | ✅ Full | Real git remote, real worker process — the strongest e2e in the repo for the plugin layer. |
| Packaged/standalone runtime (marketplace payload has no monorepo or vendor leakage, every host hook loads and runs from the copied install) | `packages/plugin/vendor/**` (generated) | `test/standalone-smoke.test.ts`, `test/vendor-smoke.test.ts` | ✅ Full | — |
| `hooks.json` / `codex-hooks.json` / `.claude-plugin/plugin.json` / `.codex-plugin/plugin.json` wiring | manifests | `test/manifest.test.ts` | ✅ Full | Checks the manifests are internally consistent (versions agree, referenced scripts exist) — not that Claude Code itself reads them correctly (see MCP live-handshake row above; the same caveat applies to plugin manifest consumption). |
| `pre-compact.mjs` / `user-prompt-submit.mjs` throttling and `DISABLE_HOOKS` no-op | `hooks/pre-compact.mjs`, `hooks/user-prompt-submit.mjs` | `test/realdeps.test.ts` | ✅ Full | — |
| Live installation into a real Claude Code / Codex settings dir, restart, and observed hook firing | — | ⚠️ Manual-by-necessity | Everything above proves the hooks behave correctly when invoked with the right stdin/argv shape. Nothing drives an actual Claude Code or Codex session that fires the hooks itself. An automated version would need a scripted host CLI session — same class of gap as the MCP live-handshake row. |

## Named gaps (summary)

Ranked by how much it would hurt if the untested/thinly-tested thing broke silently:

1. **True simultaneous-process id collision on `writeNote`** — only reachable today by mocking
   `shortId()`; the fail-closed `fs.link` path is proven correct in isolation (#101) but never
   driven by two real racing processes writing the exact same id.
2. **`staging.ts` edge cases** (e.g., re-staging an id already pending) — the promote flow around
   it is thoroughly tested, but the staging primitive itself has one test.
3. **Live handshake against a real Claude Code / Codex client** (both MCP stdio and the plugin
   hook manifests) — manual-by-necessity, not a suite gap, but worth a standing manual check
   before each release per `docs/release-checklist.md`.
4. **Statistical bound on id collision-resistance** — the 4-char suffix space is only spot-checked
   for uniqueness over 50 draws, not proven against the actual daily write volume a busy brain
   would see.

None of these are "broken and marked green" — they are real, named absences of automation, which
is the entire point of this page.
