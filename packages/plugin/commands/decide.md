---
description: Record a team/business decision in the brain (what, when, who, why)
argument-hint: [the decision that was made]
allowed-tools: Bash
---

# /commonwealth decide

Deliberately record a **decision** — a business or team choice, an assumption being locked in,
a direction that was picked — into the team brain, so there is a durable trace of **what** was
decided, **when**, **by whom**, and **why**. This is the guaranteed, explicit path (as opposed to
decisions auto-detected from a session). Decision notes are captured when the brain's `autoAdr`
feature flag is on (the default); with `autoPromote` on (the default) the note lands in canon,
otherwise it waits in the review queue for `/commonwealth:promote`.

The brain is resolved from `COMMONWEALTH_BRAIN_DIR`, else the global registry mapping for the
current directory (#69).

**Decision:** $ARGUMENTS

Before recording, make the trace complete — infer what you can from the conversation and ask the
user only for what's genuinely missing:

- **Title** — a short, specific statement of the decision (e.g. "Use Postgres for the ledger").
- **Why** — the rationale: the problem, the options weighed, and why this one won. This is the
  most valuable part; put it in the body. Note key **assumptions** the decision rests on.
- **Who** — the deciders. Use the people's names/handles; pass them to `--deciders`.
- **When** — recorded automatically (today's date); no action needed.
- **Status** — `accepted` for a decision that's been taken, `proposed` if it's still a proposal.

Then record it with the vendored curate CLI (title/body/deciders in one call), e.g.:

```
!node "${CLAUDE_PLUGIN_ROOT}/vendor/curate/index.js" stage \
  --kind decision \
  --title "<short decision statement>" \
  --body "<what was decided, the why/rationale, options considered, assumptions>" \
  --deciders "<name1>,<name2>" \
  --status accepted
```

Report the note id (printed on stdout) back to the user. If it was rejected, relay the reason —
`auto-adr-disabled` means the brain has `autoAdr` off (enable it with
`commonwealth config set autoAdr true`); `duplicate` means an equivalent decision already exists;
`contains-secret` means the text tripped the secret gate. If it was staged (not promoted), remind
the user it is pending review until `/commonwealth:promote`.
