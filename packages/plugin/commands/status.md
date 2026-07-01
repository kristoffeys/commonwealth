---
description: Show the team brain's pending review queue and sync status
allowed-tools: Bash
---

# /commonwealth status

Give the user a quick health check of their team brain: what is waiting in the review queue
and whether the local brain is in sync with its remote.

The brain is resolved from `COMMONWEALTH_BRAIN_DIR` (set by the plugin registry) or cwd.

1. List the pending staged notes (the review queue):

```
!node "${CLAUDE_PLUGIN_ROOT}/vendor/curate/index.js" list
```

2. Show whether the resident sync daemon is running for this brain (this is what
   `sync status` reports — daemon running/stopped, not git ahead/behind):

```
!node "${CLAUDE_PLUGIN_ROOT}/vendor/sync/index.js" status --dir "${COMMONWEALTH_BRAIN_DIR:-$PWD}"
```

Summarize for the user: N notes pending review (from step 1), and whether the sync daemon
is running or stopped (from step 2). If the daemon is stopped, mention they can start it
with `commonwealth-sync start`.
