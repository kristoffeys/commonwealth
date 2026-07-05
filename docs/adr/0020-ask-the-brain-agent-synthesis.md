# 20. Ask the brain: the host agent synthesizes; Commonwealth supplies cited retrieval

- Status: Accepted
- Date: 2026-07-05
- Deciders: kristof (owner), Claude (orchestrator)
- Relates: [ADR-0005](0005-search-and-embeddings.md), [ADR-0012](0012-mcp-distribution-via-plugin.md),
  [ADR-0003](0003-concurrency-model.md), issue #108

## Context

Retrieval today is **list-shaped**: `search`/`recall` return matching notes and the user still
has to read and synthesize. Retrieval quality is the multiplier on all captured knowledge — if you
can't pull the "why" back out conversationally ("why did we choose JWT over sessions for Acme?"),
capture doesn't pay off (#108).

The open design fork is **where synthesis happens** — who turns a ranked list of notes into a
one-paragraph answer with faithful citations:

1. **Commonwealth embeds an LLM** (RAG inside the tool): retrieve → call a model → return prose.
2. **The host agent synthesizes**: Commonwealth returns citation-anchored context; the agent that
   is already in the loop (Claude Code, via the MCP plugin) writes the answer.

This matters because option 1 forces a model backend, an API key, per-user config, cost, and a new
failure mode — the same "which backend?" decision that gates #107 — while option 2 leans on a model
that is, by construction, already present.

## Decision (proposed)

**The host agent is the synthesizer. Commonwealth never embeds an LLM.** "Ask the brain" is
citation-anchored retrieval plus a prompt that makes the agent answer faithfully or decline.

1. **New MCP tool `ask`.** Input: a natural-language `question` (+ optional `limit`). It runs the
   existing retrieval (FTS5 today; embeddings later, #107 — `ask` is agnostic to which), and returns
   a **budget-bounded, citation-tagged context block**: for each hit, its `id`, `kind`, `title`,
   repo-relative `path`, and a body excerpt, plus a **coverage signal** (did anything match; top
   relevance). The tool does **no** synthesis and calls **no** model. Its description instructs the
   agent: _answer only from the returned notes, cite every claim by note `id`/`path`, and if
   coverage is thin say so — never invent provenance._
2. **`/commonwealth:ask` command** (plugin). A prompt that calls `ask` and enforces the same
   contract in the session UI, so a user can literally ask a question and get a cited answer.
3. **Faithful-by-construction.** The agent can only cite `id`/`path` values the tool returned, so
   provenance cannot be fabricated: every citation resolves to a real note (verifiable with `read`).
   "Graceful I-don't-have-enough" is the coverage signal + the decline instruction, not a heuristic
   inside Commonwealth.
4. **Standalone CLI `commonwealth ask "<q>"`** (no agent present) degrades **honestly** to
   retrieval-with-citations: it prints the ranked, cited notes as an answer scaffold and states that
   synthesis happens in an agent — it does **not** fake an LLM. (This is the same retrieval `ask`
   exposes, minus the agent.)

## Non-goals

- No embedded LLM, no API key, no model download, no per-user model config inside Commonwealth
  (that would be the very backend fork we're avoiding — and it belongs to #107 for retrieval, not
  here for synthesis).
- No separate answer-synthesis service or cache.
- Retrieval **quality** (semantic recall, contradiction awareness) is #107 and orthogonal: `ask`
  consumes whatever retrieval exists and improves for free when embeddings land.

## Consequences

- **Positive.** Zero new dependency, key, or cost. Latency = one retrieval call (no model round-trip
  added by us). Faithful citations are structural, not best-effort. Works the moment the plugin is
  installed, because the synthesizer ships with Claude Code. Federated cross-brain answers compose
  automatically once federated retrieval lands (the tool just returns more sources).
- **Trade-off.** The CLI alone can't synthesize prose — it returns cited retrieval. That is an
  honest limitation, not a hidden one, and matches "don't build what the host already provides."
- **Portability.** Non-Claude agents that speak MCP get the same `ask` tool + contract; and the
  `emit` files (#135) already carry canon to Cursor/Copilot, so those tools can answer from the
  brain too. The design isn't Claude-only.

## Alternatives considered

- **Embed a RAG LLM in Commonwealth.** Rejected: forces a backend/key/cost decision and a new
  failure surface, duplicates a model that's already in the room for the primary (in-agent) use
  case, and would require per-user configuration — exactly the input-gated fork we avoid. If a
  server-side/headless synthesis need ever appears, it can be added behind an optional adapter
  without changing this tool's contract.
- **Return raw `search` output and stop.** That is today's state — the list-shaped retrieval #108
  is trying to move past. `ask` differs by shaping output for citation + carrying the coverage
  signal + the answer-faithfully contract.
- **A heuristic extractive summarizer (no LLM) inside the tool.** Rejected: low answer quality for
  real "why" questions, and it still can't beat the agent that's already present.

## Implementation

1. `@cmnwlth/core` (or a small `ask` helper reusing `search`): a function returning
   `{ question, hits: Array<{ id, kind, title, path, excerpt }>, coverage: { matched, topScore } }`,
   token-budgeted.
2. `@cmnwlth/mcp`: register the `ask` tool with the faithful-citation instruction in its description
   and the structured result above.
3. `@cmnwlth/plugin`: a `commands/ask.md` prompt (`/commonwealth:ask`) enforcing the contract.
4. `@cmnwlth/cli`: `commonwealth ask "<q>"` printing cited retrieval (honest "synthesis needs an
   agent" framing), reusing the core helper.
5. Tests: coverage signal (matched / thin), citations resolve to real note paths, budget honored,
   thin-coverage decline path.
