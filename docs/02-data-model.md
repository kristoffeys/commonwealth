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

## The four note kinds

From the brief: *memory / decisions / work-state / people-threads*. Each is a folder of
atomic files. One concept per file — this is what makes merges conflict-free (see
[architecture §2](01-architecture.md)).

### `memory/` — durable facts & learnings
The default kind. Gotchas, how-things-work, constraints, tribal knowledge.

```markdown
---
id: 2026-07-01-auth-choice-a1b2
kind: memory
title: Auth uses short-lived JWT + refresh in httpOnly cookie
tags: [auth, security, acme]
created: 2026-07-01
author: kristof
status: active            # active | superseded | stale
verified: 2026-07-01      # last time checked against reality (Kage-style)
sources: [decisions/2026-06-30-auth-jwt-vs-session-7c1e.md]
relates: [[people/acme-security-lead]]
---

Access tokens are 15-min JWTs; refresh token lives in an httpOnly, Secure, SameSite=Lax
cookie. **Why:** the client is a public SPA — no safe place for a long-lived secret.
Rejected: server sessions (stateful, breaks our edge deploy).
```

### `decisions/` — ADR-style, one per decision
The *reasoning layer* — the thing teams lose. Capture the decision, the why, the
rejected options, and what it supersedes.

```markdown
---
id: 2026-06-30-auth-jwt-vs-session-7c1e
kind: decision
title: JWT over server sessions for Acme SPA
tags: [auth, architecture, acme]
created: 2026-06-30
author: kristof
status: accepted          # proposed | accepted | superseded
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
kind that gets *edited* rather than appended (status changes), so they're the primary
consumer of the write queue + section-scoped edits.

```markdown
---
id: acme-billing-migration
kind: work-state
title: Acme billing migration
tags: [acme, billing, active]
owner: kristof
status: in-progress       # planned | in-progress | blocked | done
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
context you'd want before emailing them. GBrain's people-graph, but team-shared.

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

## Cross-cutting conventions

- **`id`** — equals the filename (minus `.md`); stable, collision-proof
  (`<date>-<slug>-<shortid>`). Never reused. Renames are discouraged (breaks links);
  supersede instead.
- **Wikilinks `[[id]]`** — the graph. The curation agent extracts typed edges from these
  (à la GBrain, zero-LLM where possible: `supersedes`, `relates`, `superseded_by`,
  `deciders`). Backlinks are derived into the index.
- **`status` + supersede, never delete.** Knowledge is versioned by superseding, not
  destroying — git already keeps history; superseding keeps the *reasoning* visible.
- **`verified` / `stale`** — the curation agent stamps freshness. A brain that can't tell
  fresh from stale rots (this is why we verify, Kage-style).
- **`author` / `updated`** — provenance for trust and for the team feed.

## Derived artifacts (generated, gitignored or `merge=union`)

- **`COMMONS.md`** — the router: entry point for humans and agents, links to active
  work-state and recent decisions. Regenerated, never hand-merged.
- **Per-folder `INDEX.md`** — table of contents per kind.
- **`index/` (SQLite + vectors)** — search index; fully disposable, rebuilt from files.
- **Backlink graph** — computed from wikilinks.

## Schema versioning

`.commons/schema-version` pins the schema. The daemon migrates on version bump. Keeping
the schema in-repo means a brain is self-describing and portable — clone it anywhere and
the tooling knows how to read it.

## Why this shape wins

- **Atomic files → union merges → the concurrency problem mostly disappears.**
- **Frontmatter + wikilinks → a knowledge graph for free**, from files humans can still
  read and edit by hand.
- **Supersede-not-delete + verified stamps → the brain stays trustworthy**, the failure
  mode that kills every "just dump notes" system.
