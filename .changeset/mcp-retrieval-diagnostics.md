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
