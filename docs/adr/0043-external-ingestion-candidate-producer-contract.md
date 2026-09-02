# 43. External ingestion is a candidate-producer contract; connectors never write to the brain

- Status: Accepted
- Date: 2026-09-02
- Deciders: kristof (owner), Claude (orchestrator)
- Relates: [ADR-0018](0018-package-consolidation-spike.md) (why this lives inside `@cmnwlth/seed`,
  not a new package), [ADR-0019](0019-access-model-clone-on-demand.md) (the access model a static
  registry avoids widening), [ADR-0038](0038-capture-provenance-tier.md) (the `intake` tier the
  `ingest` runner stamps), [ADR-0044](0044-agent-assisted-ingestion.md) (the second, agent-driven
  tier this contract deliberately leaves room for), [ADR-0045](0045-external-intake-does-not-auto-promote.md)
  (where a successful run lands), issue #150 (pluggable seed connectors), the design investigation
  summarized on #150, issues #293–#299 (the implementation work this decision unblocks)

## Context

`@cmnwlth/seed` already emits `NewNoteInput[]` as JSON on stdout, and `commonwealth-curate capture
--external --force` already consumes it (`packages/seed/src/index.ts:76`,
`packages/curate/src/index.ts:484`). That pipe exists today for exactly two producers —
`git-miner.ts` and `config-importer.ts` — wired in ad hoc, with no shared interface and no registry.
#150 asks for pluggable non-git sources (GitHub discussion, meeting transcripts, and eventually
Slack/Notion/Jira) "without a new subsystem." A #150 design investigation (786-line report,
summarized in a comment on that issue) concluded the seam is real architecture, not a
retrofit — the work is formalizing a contract that already implicitly exists, plus fixing the write
path underneath it (tracked separately: #288, #289, #291, #292), not building a framework from
scratch.

The risk worth naming up front: the natural-sounding "just let connectors be pluggable npm
packages" answer is a real problem, not a convenience. Commonwealth code runs inside lifecycle
hooks with the user's git credentials and `gh` token. A per-brain `connectors` config block already
lives in the synced `.commonwealth/config.json` (ADR-0009's `features` pattern); `require()`-ing a
package *named in that file* is remote code execution triggered by an ordinary `git pull`. There are
zero third-party connector authors today, so the cost of building that loading mechanism is real
and immediate, and the benefit is entirely hypothetical.

## Decision

1. **A connector is a pure function from `(config, cursor)` to a stream of candidates — nothing
   else.** No note IO, no git, no staging, no promotion, no `intake` stamping, no id derivation.
   Every gate in the system (secret scan, scope, dedup, `autoAdr`, `autoPromote`, receipts,
   attribution) lives behind `captureCandidates`, and a connector that writes notes directly is a
   connector that bypasses all of them. This decision makes that non-negotiable rather than merely
   conventional:

   ```
   type ConnectorId = "git" | "agent-config" | "github" | ...;

   interface UpstreamRef {
     uri: string;         // stable, canonical, opaque identity: "github://owner/repo/pull/N#..."
     createdAt: string;   // upstream creation date — stable across edits, drives the id
     updatedAt: string;   // drives the cursor and edit detection
     digest: string;      // sha256 of the upstream content this candidate was distilled from
     author?: { displayName: string; email?: string; handle?: string };
   }

   interface ExternalCandidate {
     note: NewNoteInput;  // WITHOUT id, intake, author_ref — the runner owns those
     upstream: UpstreamRef;
     excerpt: string;     // verbatim source text, capped, non-optional
   }

   interface Connector {
     id: ConnectorId;
     label: string;
     tier: "deterministic" | "agent-assisted";
     configSchema: ZodType;                 // must declare a non-empty source allowlist
     probe(config): Promise<ProbeResult>;   // auth + reachability + scope, zero writes
     pull(run: ConnectorRun): AsyncIterable<ExternalCandidate>;
     advance(cursor, seen: UpstreamRef[]): ConnectorCursor;  // pure; caller persists on success
   }
   ```

   `pull` returns an `AsyncIterable`, not an array: a long-lived source does not have to fit in
   memory or in one capture batch, and a per-run budget (`ConnectorRun.limits`) must be enforceable
   mid-pull, not only at the end. `ExternalCandidate.note` structurally omits `id`, `intake`, and
   `author_ref` — the same discipline ADR-0038 §4 already applies at the call-site level
   (`withRunIntake`, `packages/curate/src/capture.ts:90`), made a type-level guarantee instead of a
   defensive strip, because a candidate is frequently extracted by a model FROM the very external
   content whose trust is being graded, so a self-declared tier or id can never be trusted.
   `excerpt` is non-optional for the same reason ADR-0029's attribution work already trusts
   `author`: a paraphrase attributed to a named human is an assertion about a real person, and it
   is only checkable if the verbatim source text travels with it.

2. **All note IO, id derivation, attribution, tier declaration, gating, and landing belong to the
   trusted `ingest` runner — never the connector.** The runner is the only code that calls
   `captureCandidates`. A connector cannot promote itself to canon, cannot mark its own output
   `internal`, and cannot choose its own note id, by construction.

3. **Connectors live in a static typed registry inside `@cmnwlth/seed`, not a new package.**
   `export const CONNECTORS: Record<ConnectorId, Connector>`. ADR-0018 already spiked package
   proliferation, and `seed` *is* the ingestion package — its current git-only scope is an accident
   of what shipped first, not a boundary worth defending. `git-miner.ts` and `config-importer.ts`
   become the first two registry entries, unchanged in behaviour: today's
   `gatherCandidates(repoDir)` is exactly `connectors.git.pull()` plus
   `connectors.agentConfig.pull()` with the cursor omitted.

4. **Per-brain enablement, not per-brain code.** Which connectors are turned on for a brain is a
   new `connectors` block in the synced `.commonwealth/config.json`, alongside the existing
   `features` map (`packages/core/src/config.ts:108-175`). The registry itself does not vary per
   brain; only which of its fixed entries are active does.

5. **No dynamic loading of third-party code in v1.** The registry is closed. If external
   connector authorship is ever wanted, the safe shape is a **subprocess contract**: any executable
   that prints candidate JSON on stdout is a connector, with no in-process `require()`/`import()` of
   anything named in a repo-synced file. This decision documents that extension point; it does not
   build it.

## Rejected

- **Dynamic loading of npm packages named in `.commonwealth/config.json`.** Turns a `git pull` into
  arbitrary code execution with the user's git and `gh` credentials, for a use case (third-party
  connector authors) that has zero instances today. The subprocess alternative gets the same
  extensibility without ever loading foreign code into the trusted process.
- **A new `@cmnwlth/ingest` (or similar) package.** ADR-0018's package-consolidation spike already
  argued against proliferation, and the seam these connectors formalize already lives, in practice,
  inside `seed`. A new package boundary here would separate a producer from the registry that
  enumerates producers for no structural reason.
- **Letting a connector call `capture` itself.** Considered and rejected as the whole point of this
  ADR: every downstream gate depends on the runner being the sole caller. A connector with its own
  path to canon is a connector that can silently skip curation.

## Consequences

- `git` and `agent-config` re-expressed as registry entries, plus a genuinely different third entry
  (the GitHub connector, #298 — structured API vs. `git-miner`'s local repo walk), is the interface
  validation this ADR is betting on: if the contract survives a source that dissimilar, it is a
  real contract, not one shaped by its first user.
- A connector cannot bypass the secret scan, the dedup gate, the durability judge, or the
  `autoPromote`/landing policy (ADR-0045) — those all sit downstream of `captureCandidates`, which
  only the runner calls.
- `ConnectorRun.limits` (`maxCandidates`, `maxApiCalls`, `deadlineMs`) gives every connector a
  structural place to enforce a budget, without this ADR picking the actual ceiling — that is
  Open Question 5 from the design investigation, for the runner (#294) to default sensibly and for
  Kristof to tune.
- Trade-off accepted: zero third-party connector authorship in v1, deliberately. The subprocess
  extension point is documented, not implemented — a real gap if outside authorship is ever wanted,
  closed the moment there is evidence anyone wants it.

## Not deciding yet

- **Which sources ship, beyond `git`/`agent-config`/`github`.** The ranked ladder (GitHub, meeting
  transcripts, Notion/Confluence, Linear/Jira, Productive, Slack, and email as a likely "no") is the
  design investigation's recommendation, not this ADR's decision — it is realized phase by phase as
  separate issues (#150's phased plan), most of which (Phase 2 onward) are not yet filed.
- **The secrets and sensitivity posture for external content** (entropy detection, a
  content-sensitivity classifier, no-DMs-in-v1) beyond the structural requirement that every
  `configSchema` declare a non-empty allowlist. That is Phase 2 scope and does not have an ADR yet.
- **The exact shape and enforcement of `ConnectorRun.limits`' budget values** — the fields exist by
  this decision; the numbers are Kristof's call (Open Question 5).
- **The subprocess extension point's wire format**, beyond "prints candidate JSON on stdout" — not
  specified further because nothing consumes it yet.
