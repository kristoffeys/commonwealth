---
description: Stage a note into the team brain's review queue (memory by default)
argument-hint: [what to remember]
allowed-tools: Bash
---

# /commons remember

Manually capture a piece of knowledge into the team brain's **staging review queue**
(ADR-0007). It is _staged_, not canon — someone approves it later with `/commons promote`.

The note kind defaults to `memory`. The brain is resolved from `COMMONS_BRAIN_DIR` (set by
the Commons plugin's registry) or the current directory.

Stage the following into the brain, choosing an appropriate short title and, if it is a
clear decision, using `--kind decision` (only staged if the team enabled the `autoAdr`
feature flag):

**Content:** $ARGUMENTS

Run the vendored curate CLI to stage it, e.g.:

```
!node "${CLAUDE_PLUGIN_ROOT}/vendor/curate/index.js" stage --kind memory --title "<short title>" --body "$ARGUMENTS"
```

Then report the staged note id (printed on stdout) back to the user, and remind them it is
pending review until promoted.
