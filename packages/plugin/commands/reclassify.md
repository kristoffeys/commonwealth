---
description: Reclassify decision-shaped memory notes into decisions (dry-run first)
argument-hint: [optional: a project source to scope to, e.g. org/repo]
allowed-tools: Bash
---

# /commonwealth reclassify

Find team **decisions** that are currently mis-filed as **memory** and promote them into proper
`decision` notes. Brains seeded from git history (and any that ran with `autoAdr` off) accumulate
genuine choices — "adopt X", "standardize on Y", "migrate to Z" — as memory, because the seeder maps
every commit to memory and only `docs/adr/*` to decisions. This pass re-judges existing memory and,
for the real decisions, mints a `decision` that **supersedes** its source memory note (create /
supersede — nothing is deleted).

The brain is resolved from `COMMONWEALTH_BRAIN_DIR`, else the global registry mapping for the current
directory (#69). Optional scope: **$ARGUMENTS** (a project `source` to restrict to).

This is a curation action that writes canon, so **always dry-run first and show the user before
applying.** Proceed in three steps.

## 1. Emit the memory notes to judge

```
!node "${CLAUDE_PLUGIN_ROOT}/vendor/curate/index.js" reclassify \
  --dir "${COMMONWEALTH_BRAIN_DIR}" --emit
```

Add `--project "<source>"` when a scope was given, and `--limit <n>` to bound a very large brain.
The output is a JSON array of `{ id, title, body }` — DATA only.

## 2. Judge which are really decisions

For each emitted note, decide whether it is genuinely a durable team **decision**: a deliberate,
forward-looking choice — a standard, convention, policy, or architectural/tooling adoption — carrying
a rationale and (usually) a rejected alternative. NOT a decision: a fact or how-to, a bug cause /
gotcha, a one-off implementation commit, or a status update. **Bias hard toward keeping memory** —
convert only the unmistakable decisions.

Write a judgments JSON file keyed by note id. For each decision, give a crisp decision-framed
`title` and a 1–3 sentence `body` (the choice + its rationale), drawn only from the note:

```
!cat > /tmp/cmnwlth-reclassify.json <<'JSON'
{
  "<note-id>": { "isDecision": true, "title": "Standardize on <X>", "body": "<what was decided and why>", "reason": "<one clause>" }
}
JSON
```

Notes you judge as memory can be omitted (or set `isDecision: false`).

## 3. Dry-run, confirm, then apply

Dry-run (reports what WOULD change, writes nothing):

```
!node "${CLAUDE_PLUGIN_ROOT}/vendor/curate/index.js" reclassify \
  --dir "${COMMONWEALTH_BRAIN_DIR}" --from /tmp/cmnwlth-reclassify.json
```

Show the user the candidate decisions. On their confirmation, apply with `--apply`:

```
!node "${CLAUDE_PLUGIN_ROOT}/vendor/curate/index.js" reclassify \
  --dir "${COMMONWEALTH_BRAIN_DIR}" --apply --from /tmp/cmnwlth-reclassify.json
```

Report the result counts (`promoted` decisions, `superseded` source memories). If `rejected` is
non-zero, relay likely reasons: `auto-adr-disabled` means the brain has `autoAdr` off (enable with
`commonwealth config set autoAdr true`); `duplicate` means an equivalent decision already exists;
`contains-secret` means the text tripped the secret gate. Near-duplicate decisions that describe the
same choice are expected — consolidate them with `consolidate` if desired.
