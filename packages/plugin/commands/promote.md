---
description: Approve staged notes into canon (or list what is pending)
argument-hint: [note-id ...]
allowed-tools: Bash
---

# /commonwealth promote

Approve one or more **staged** notes into the brain's canonical folders (ADR-0007). Approval
is the review gate: staged notes never become canon until promoted. Approved notes are
written as fresh atomic files and are what actually syncs to the team (ADR-0008).

The brain is resolved from `COMMONWEALTH_BRAIN_DIR` (set by the plugin registry) or cwd.

If the user supplied note ids in `$ARGUMENTS`, approve them:

```
!node "${CLAUDE_PLUGIN_ROOT}/vendor/curate/index.js" approve $ARGUMENTS
```

If `$ARGUMENTS` is empty, first show what is pending so the user can choose:

```
!node "${CLAUDE_PLUGIN_ROOT}/vendor/curate/index.js" list
```

Report the canonical paths printed on stdout for each approved note.
