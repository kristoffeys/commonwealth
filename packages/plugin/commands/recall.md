---
description: Recall relevant knowledge from the team brain
argument-hint: [optional search query]
allowed-tools: Bash
---

# /commonwealth recall

Surface relevant knowledge from the team brain for the current work. This is the same
relevance-gated selection the SessionStart hook injects automatically — use it to pull
context on demand (optionally narrowed by a query).

The brain is resolved from `COMMONWEALTH_BRAIN_DIR` (set by the plugin registry) or cwd. The
per-user scope filter (ADR-0008) still applies: out-of-scope directories return nothing.

Run the vendored curate CLI's `context` command. If the user gave a query, pass it:

```
!node "${CLAUDE_PLUGIN_ROOT}/vendor/curate/index.js" context --cwd "${CLAUDE_PROJECT_DIR:-$PWD}" --query "$ARGUMENTS"
```

If `$ARGUMENTS` is empty, omit `--query`. Present the returned markdown bullets to the user.
For richer, full-text search prefer the `commonwealth` MCP server's `search` / `read`
tools when available.
