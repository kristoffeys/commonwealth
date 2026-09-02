---
"@cmnwlth/mcp": minor
"@cmnwlth/sync": minor
---

Sync writes from hosts that do not run Commonwealth's lifecycle hooks (ADR-0040). The MCP server
now pulls once at startup and commits + pushes a note as it lands in canon, and the `remember`
answer says whether it actually reached the remote — previously a note written from Claude
Desktop's Chat tab or any bare MCP client stayed an untracked working-tree file while the tool
reported success. Gated by `COMMONWEALTH_MCP_SYNC` (default on; the plugin sets it to `off`, so
Claude Code and Codex keep syncing through their hooks exactly as before). `@cmnwlth/sync` gains a
library entry so the existing engine can be reused in-process rather than reimplemented.
