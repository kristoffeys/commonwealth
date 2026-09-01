---
description: Summarize a meeting into the brain and extract its decisions, action items, and facts
argument-hint: [paste the transcript / notes]
allowed-tools: Bash
---

# /commonwealth meeting

Summarize a meeting into the team brain and extract its decisions, action items, and durable facts.
You paste raw meeting material — a Plaud export, a recording transcript, or hand-typed notes — and
it is stored **hybrid** (ADR-0036): one immutable `meeting` record note holds a clean structured
summary with the raw transcript folded in at the bottom, and each extracted decision / action item /
durable fact becomes its own atomic note cross-linked back to that record.

The brain is resolved from `COMMONWEALTH_BRAIN_DIR`, else the global registry mapping for the
current directory (#69). Everything goes through the normal curation gates (secret scan, dedup) and
the brain's `autoPromote` setting, exactly like `/commonwealth:remember`.

**Raw meeting material:** $ARGUMENTS

## What you do

You (the host agent) do the summarizing and extracting — Commonwealth only stores. If `$ARGUMENTS`
is empty, ask the user to paste the transcript (and, if handy, the meeting title, attendees, and
date), then proceed.

1. **Summarize.** Produce a concise structured summary: a one-line purpose, the attendees, the
   meeting date, and the key points discussed. Then, separately, extract:
   - **Decisions** — each choice that was locked in (→ a `decision` note).
   - **Action items** — each next step, **with an owner** (→ a `work-state` note).
   - **Durable facts** — learnings/context worth keeping (→ a `memory` note).

2. **Stage the meeting record FIRST.** The body is the structured summary followed by the full raw
   transcript under a `## Transcript` heading. Pipe the body via STDIN (`--body -`) so a large
   transcript is never placed on the command line (ARG_MAX). Capture the printed meeting id.

   ```
   !printf '%s' "<summary + \n## Transcript\n + raw transcript>" | \
     node "${CLAUDE_PLUGIN_ROOT}/vendor/curate/index.js" stage \
       --kind meeting \
       --title "<short meeting title>" \
       --meeting-date "<YYYY-MM-DD>" \
       --attendees "<name1, name2, name3>" \
       --source-type "<plaud|recording|paste|manual>" \
       --body -
   ```

   The first stdout line is the staged meeting note id (e.g. `2026-09-01-standup-a1b2`). Read it.

3. **Stage each extracted note**, cross-linked back to the meeting with `--relates <meeting-id>`:

   ```
   !node "${CLAUDE_PLUGIN_ROOT}/vendor/curate/index.js" stage \
     --kind decision --title "<decision>" --relates "<meeting-id>" \
     --body "<what was decided and why>"

   !node "${CLAUDE_PLUGIN_ROOT}/vendor/curate/index.js" stage \
     --kind work-state --title "<action item>" --owner "<owner>" --relates "<meeting-id>" \
     --body "<the action item, its owner, and any due date>"

   !node "${CLAUDE_PLUGIN_ROOT}/vendor/curate/index.js" stage \
     --kind memory --title "<fact>" --relates "<meeting-id>" \
     --body "<the durable fact / learning>"
   ```

4. **Report back**: the meeting id and a short summary of what was extracted (how many decisions,
   action items, and facts, each with its staged note id). If any note was rejected, relay the
   reason (`duplicate`, `contains-secret`). If notes were staged (not promoted), remind the user
   they are pending review until `/commonwealth:promote`.
