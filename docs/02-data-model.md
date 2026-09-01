---
title: Data Model — the markdown schema
type: reference
status: draft
updated: 2026-07-01
tags: [data-model, schema, markdown, frontmatter]
---

# Data Model — the markdown schema

Design goals: **human-readable and hand-editable**, **agent-parseable**,
**concurrency-safe** (atomic files that union-merge), and **diffable** in git/PRs.
Everything is markdown with YAML frontmatter. No format that only a machine can read.

## The five note kinds

From the brief: _memory / decisions / work-state / people-threads_, plus _meetings_. Each is a
folder of atomic files. One concept per file — this is what makes merges conflict-free (see
[architecture §2](01-architecture.md)). Meetings are the one deliberate exception (see below): a
meeting record is an immutable *event* blob, while the decisions and actions inside it are still
extracted as atomic notes.

### `memory/` — durable facts & learnings

The default kind. Gotchas, how-things-work, constraints, tribal knowledge.

```markdown
---
id: 2026-07-01-auth-choice-a1b2
kind: memory
title: Auth uses short-lived JWT + refresh in httpOnly cookie
tags: [auth, security, acme]
created: 2026-07-01
author: Kristof Feys
author_ref: contributor-kristof-feys-2d5a7ee6f7
status: active # active | superseded | stale
verified: 2026-07-01 # last time checked against reality
sources: [decisions/2026-06-30-auth-jwt-vs-session-7c1e.md]
relates: [contributor-kristof-feys-2d5a7ee6f7, people/acme-security-lead]
---

Access tokens are 15-min JWTs; refresh token lives in an httpOnly, Secure, SameSite=Lax
cookie. **Why:** the client is a public SPA — no safe place for a long-lived secret.
Rejected: server sessions (stateful, breaks our edge deploy).
```

### `decisions/` — ADR-style, one per decision

The _reasoning layer_ — the thing teams lose. Capture the decision, the why, the
rejected options, and what it supersedes.

```markdown
---
id: 2026-06-30-auth-jwt-vs-session-7c1e
kind: decision
title: JWT over server sessions for Acme SPA
tags: [auth, architecture, acme]
created: 2026-06-30
author: kristof
status: accepted # proposed | accepted | superseded
supersedes: []
superseded_by: null
deciders: [kristof, acme-security-lead]
---

## Context

Public SPA on edge runtime; no sticky sessions.

## Decision

Short-lived JWT + refresh cookie.

## Rejected

- Server sessions — stateful, incompatible with edge deploy.
- Long-lived JWT — no safe client storage.

## Consequences

Need refresh-rotation + revocation list. See [[memory/2026-07-01-auth-choice-a1b2]].
```

### `work-state/` — current status per workstream

The "what's happening right now" layer that makes onboarding instant. These are the one
kind that gets _edited_ rather than appended (status changes), so they're the primary
consumer of the write queue + section-scoped edits.

```markdown
---
id: acme-billing-migration
kind: work-state
title: Acme billing migration
tags: [acme, billing, active]
owner: kristof
status: in-progress # planned | in-progress | blocked | done
updated: 2026-07-01
relates: [[decisions/...], [[people/acme-billing-lead]]]
---

## Now

Migrating invoices to new schema; dual-write live since 2026-06-28.

## Next

Backfill historical invoices, then cut reads over.

## Blockers

Waiting on Acme to confirm tax-rounding rule → [[people/acme-billing-lead]].
```

### `people/` — people-threads

One file per person/relationship (teammate, client contact, vendor). The thread of
context you'd want before emailing them — a people-graph, team-shared.

```markdown
---
id: acme-billing-lead
kind: person
name: Dana Ruiz
org: Acme
role: Billing lead
tags: [acme, client, billing]
updated: 2026-07-01
---

Owns Acme's billing rules. Prefers async, decisive. Open thread: confirming the
tax-rounding rule blocking [[work-state/acme-billing-migration]]. History: pushed back
on our timeline in June — sensitive to scope creep.
```

### `meetings/` — immutable meeting records (paste-and-summarize)

A user pastes raw meeting material — a Plaud export, a call transcript, or notes — and it is stored
**hybrid** (ADR-0036): one immutable `meeting` record note holds a clean structured summary with the
raw transcript folded in at the bottom, and each decision / action item / durable fact inside it is
**extracted as its own atomic note** (`decision` / `work-state` / `memory`), cross-linked to the
record via `relates`. The summarizing and extracting is done by the host agent running
`/commonwealth:meeting` (host synthesizes, Commonwealth stores — ADR-0020); the record is the
re-mineable backstop if a decision was missed.

```markdown
---
id: 2026-08-31-acme-standup-a1b2
kind: meeting
title: Acme weekly standup
tags: [acme, standup]
created: 2026-09-01
author: Kristof Feys
meeting_date: 2026-08-31 # when the meeting took place (YYYY-MM-DD)
attendees: [kristof, dana, acme-billing-lead]
source_type: plaud # plaud | recording | paste | manual
relates:
  [decisions/2026-09-01-ship-storefront-c3d4, work-state/2026-09-01-storefront-spec-e5f6]
---

## Summary

Agreed to ship the storefront before the admin panel; Bob owns the spec draft.

## Transcript

kristof: let's start with the storefront…
dana: …
```

Frontmatter beyond the [common fields](#cross-cutting-conventions): **`meeting_date`** (required,
`YYYY-MM-DD`) is the calendar date the meeting happened (distinct from `created`, the capture date);
**`attendees`** is a free-form string array of names/handles; **`source_type`** (optional) records how
the raw material arrived. The extracted notes each carry `relates: <meeting-id>` back to the record,
and the record's `relates` lists them. The meeting record is immutable — never edited or superseded,
only referenced. Its transcript passes the same secret-scan + dedup gates as any staged write, and a
large transcript is piped via STDIN (`stage … --body -`) rather than passed on the command line.

## Cross-cutting conventions

- **`id`** — equals the filename (minus `.md`); stable, collision-proof
  (`<date>-<slug>-<shortid>`). Never reused. Renames are discouraged (breaks links);
  supersede instead.
- **Wikilinks `[[id]]`** — the graph. Typed edges are extracted from these without an LLM
  where possible (`supersedes`, `relates`, `superseded_by`, `deciders`). Backlinks are derived
  into the index.
- **`status` + supersede, never delete.** Knowledge is versioned by superseding, not
  destroying — git already keeps history; superseding keeps the _reasoning_ visible.
- **`verified` / `stale`** — freshness is stamped during curation. A brain that can't tell
  fresh from stale rots — which is why notes carry a freshness signal.
- **`author` / `author_ref` / `updated`** — responsibility provenance for trust and the team feed.
  Person-authored writes resolve `COMMONWEALTH_AUTHOR`, then Git identity, and finally the local OS
  account. Commonwealth creates the contributor `person` note once and
  stores its stable id in `author_ref`; `relates` also carries that id as a graph edge. Set
  `COMMONWEALTH_AUTHOR` and optionally `COMMONWEALTH_AUTHOR_EMAIL` to override local identity.
- **`graduate`** — opt-in marker (`graduate: true`) that a note may be promoted to the
  org-brain, the audience-widening promotion of knowledge that recurs across ≥2 project brains
  (ADR-0023). Absent/`false` keeps the note in its repo. Strictly opt-in and even then staged for
  manual review — graduation never leaves a repo silently.

## Derived artifacts (generated, gitignored or `merge=union`)

- **`COMMONWEALTH.md`** — the router: entry point for humans and agents, links to active
  work-state and recent decisions. Regenerated, never hand-merged.
- **Per-folder `INDEX.md`** — table of contents per kind.
- **`index/` (SQLite + vectors)** — search index; fully disposable, rebuilt from files.
- **Backlink graph** — computed from wikilinks.

## Schema versioning

`.commonwealth/schema-version` pins the schema. The daemon migrates on version bump. Keeping
the schema in-repo means a brain is self-describing and portable — clone it anywhere and
the tooling knows how to read it.

## Why this shape wins

- **Atomic files → union merges → the concurrency problem mostly disappears.**
- **Frontmatter + wikilinks → a knowledge graph for free**, from files humans can still
  read and edit by hand.
- **Supersede-not-delete + verified stamps → the brain stays trustworthy**, the failure
  mode that kills every "just dump notes" system.
