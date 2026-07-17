# 33. Action-time contradiction guard (PreToolUse, opt-in, non-blocking default)

- Status: Accepted
- Date: 2026-07-17
- Deciders: kristof (owner); Claude (orchestrator, proposer)
- Relates: [ADR-0021](0021-embeddings-semantic-dedup.md) (embeddings + per-note vectors this reuses),
  [ADR-0025](0025-hybrid-semantic-retrieval.md) (the cached-embedder / fail-open-on-timeout posture),
  [ADR-0007](0007-curation-review-gate.md)/[ADR-0014](0014-auto-promotion-default.md) (curation gating),
  [ADR-0030](0030-llm-curation-pass.md) (capture-time CONTRADICTS classifier — the sibling),
  [ADR-0027](0027-host-neutral-extraction-runtime.md) (the portable hook runtime), issue #199

> The capture-time contradiction signal (ADR-0030's CONTRADICTS verdict) catches disagreements when
> a note is *written*. This ADR adds the other half ADR-0021 deferred: catching a contradiction at
> the moment a teammate's agent is about to *act* against a recorded decision. It changes no behavior
> until the `contradictionGuard` flag is turned on (default OFF).

## Context

Commonwealth already records `decision` notes and, at capture time, can flag a new note that
CONTRADICTS canon (ADR-0030). But the highest-leverage moment to surface a contradiction is not when
knowledge is written — it is when an agent is about to *do* something that cuts against a standing
decision (rewrite the datastore layer the team decided against, disable a flag a decision pinned on).
No competitor does action-time knowledge enforcement; #199 scored it the highest-differentiation
item in the API-opportunity audit.

The retrieval machinery already exists: ADR-0021 ships an embeddings provider and a per-note
`vectors` table, and `loadVectors` + `cosineSimilarity` are in core. So the guard can embed a
summary of the pending change and nearest-neighbor it against `decision` vectors — no new matching
engine.

Two hazards dominate the design:

1. **This is the tool hot path.** A PreToolUse hook fires on *every* Write/Edit/Bash. Cold-loading a
   local embedding model costs seconds; even a hosted call is ~100ms. An unbounded check would add
   perceptible latency to every action, or wedge the session.
2. **False positives are corrosive.** A gate that cries wolf — or worse, *blocks* — trains users to
   ignore or disable it. Prior art (selvedge's PreToolUse gate) resolves this with a
   fail-open, precision-over-recall posture and one-nudge-per-session acknowledgment files; MAMA
   keeps hook-time semantic search fast with a resident embedding server. The owner's call for #199
   was explicit: **build it conservatively — it must fire rarely and NEVER hard-stop the user.**

The genuine fork was **gate vs. nudge**: escalate to a permission prompt (`ask`) so the user must
confirm, or inject a non-blocking warning into the agent's context and let the tool run. A default
gate is higher-friction and, given cosine's false-positive rate on "contradiction" (ADR-0021's exact
reason for deferring this), would gate wrongly often enough to get switched off.

## Decision

1. **Opt-in, default OFF.** A new `contradictionGuard` feature flag in core `FEATURE_FLAGS`, default
   `false` — unlike `semanticSearch`/`llmCurator` (default on, inert without a runtime), because this
   flag changes tool hot-path behavior. A team turns it on deliberately. Flag on but no resolvable
   embeddings provider (ADR-0021) → silent no-op.

2. **Non-blocking by default; `ask` is opt-in.** On a detected contradiction the guard returns a
   PreToolUse `additionalContext` warning — `⚠ This change may contradict decision [[<id>]]: <title>
   — … Cited: <path>` — injected into the agent's context; **the tool still runs.** A per-brain
   `contradictionGuard.mode: "warn" | "ask"` (default `"warn"`) can raise it to
   `permissionDecision: "ask"` for teams that want a stop-and-confirm. Warn, not ask, is the default:
   the owner wants awareness, not a gate.

3. **Decision notes only.** The guard compares only against non-superseded `kind: decision` vectors —
   never memory/work-state. A decision is the only note kind whose *violation* is meaningful at
   action time.

4. **Hot-path safety is paramount (fail-open).** The whole check runs under a hard
   `GUARD_TIMEOUT_MS` (300ms) `Promise.race`; on timeout **or any error** the tool is ALLOWED with at
   most one stderr breadcrumb. A cheap config read gates first, so the default-off / no-provider case
   costs a single `stat`+read and zero embedding work. Only a compact summary of the change (the Bash
   command, the new file content, the edited text) is embedded — never whole files — bounded to 2KB.
   Cold/slow embedders therefore degrade to "no warning this time", never to added latency. This is
   the same fail-open-on-timeout discipline ADR-0025 uses for hybrid retrieval.

5. **Session-dedup (one nudge per decision).** Once a decision has been warned about in a session, it
   is not re-warned — a per-session marker file (`contradiction-warned-<session>.json`, next to the
   capture marks), mirroring the extraction recursion guard's marker pattern and selvedge's
   acknowledgment files. The guard nudges once, not on every keystroke.

6. **High threshold.** A hit is surfaced only at cosine ≥ `contradictionGuard.threshold` (default
   **0.82**, deliberately high). Better to miss than to cry wolf.

7. **Reuse the embeddings path; portable hook wiring.** The guard hook
   (`hooks/contradiction-guard.mjs` → `contradictionGuard()` in `hooks/lib.mjs`) shells to a new
   `commonwealth-curate contradiction-check` subcommand (which calls `checkContradiction()` in the
   curate package), exactly as the capture/neighbors hooks already reach core through curate
   (ADR-0026/0027). It does not import core or hand-roll cosine. The recursion guard
   (`COMMONWEALTH_DISABLE_HOOKS`) already stops the extraction/classifier `claude -p` children from
   re-firing it. Wired into `hooks.json` PreToolUse with a `Write|Edit|MultiEdit|Bash` matcher —
   **only for Claude**, not `codex-hooks.json` (Codex's four-event contract is unchanged).

## Consequences

- Teams that opt in get an action-time nudge when an agent is about to contradict a recorded
  decision, at zero added latency in the common (no-contradiction / cold-embedder) case, and with no
  possibility of a hard stop unless they choose `ask` mode.
- With the flag off (default) the tool hot path is unchanged apart from one cheap config read.
- The guard is precision-biased: a high threshold + decision-only + session-dedup means it will miss
  some real contradictions. That is the intended trade — a guard that cries wolf gets disabled.
- Latency remains the operational risk with the `local` provider (cold model load ≫ 300ms → always
  fail-open → never fires). A resident embedding server (MAMA-style, warmed at SessionStart) or the
  `hosted` provider are the paths to make it fire reliably; both are follow-ups, out of this ADR.
- `ask` mode makes the guard blocking by choice; teams that enable it accept the extra friction.
