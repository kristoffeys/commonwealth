---
"@cmnwlth/mcp": minor
"@cmnwlth/core": minor
---

Surface retrieval diagnostics through the `search` and `ask` MCP tools: both now accept
`diagnostics` and `minLexicalSupport` params (default off/unchanged), and each result's
`ResultDiagnostics` additionally reports the `minLexicalSupport` threshold it was judged against —
so an agent can see how well-supported a citation is before relying on it. `ask`'s
`coverage.prunedBelowThreshold` reports the result-set-level "kept/dropped" signal: how many
candidates were pruned below that threshold before ranking, so an agent can tell when the brain may
cover a question better than the returned hits suggest. Purely additive; ranking and default
response shape are unchanged.

**Breaking-ish note:** an earlier merge to `main` (#279) briefly shipped `ResultDiagnostics.
clearedThreshold`, a field that was hardcoded `true` in the hybrid path and `null` in the
lexical path — provably constant and misleading, since it reads like evidence of citation quality
but is a tautology (a *returned* hit is always kept by construction). This changeset removes it
before any release ships it. Anyone who consumed `main` directly between that merge and this one
and started depending on `clearedThreshold` needs to drop that read; `threshold` (the bar itself)
is unaffected and remains the informative field.
