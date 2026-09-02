---
"@cmnwlth/mcp": minor
"@cmnwlth/core": minor
---

Surface retrieval diagnostics through the `search` and `ask` MCP tools: both now accept
`diagnostics` and `minLexicalSupport` params (default off/unchanged), and each result's
`ResultDiagnostics` additionally reports the `minLexicalSupport` threshold it was judged against
and whether it cleared it — so an agent can see how well-supported a citation is before relying on
it. Purely additive; ranking and default response shape are unchanged.
