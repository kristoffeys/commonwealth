# ADR-0029: Person responsibility attribution

**Status:** Accepted

## Context

Notes could carry a free-text `author`, but that value did not identify a person note and automatic
capture did not populate it. Consequently the graph could not reliably answer who contributed a
memory.

## Decision

Every interactive or automatic write resolves a contributor identity, ensures a canonical `person`
note exists, and writes both:

- `author`: the contributor's display name;
- `author_ref`: the stable person-note ID.

The person ID is also included in `relates`, so existing graph traversal and orphan health checks
recognize responsibility links without a second graph mechanism.

Identity resolution uses, in order: `COMMONWEALTH_AUTHOR`, `GIT_AUTHOR_NAME`, Git `user.name`, and
the operating-system account. Email follows the
corresponding Commonwealth or Git identity when available. Contributor person IDs are deterministic,
and concurrent first writes converge on the same note.

Explicit bulk import and seeding through `capture --force` remain exempt: imported facts may not
have been authored by the operator running the import.

## Consequences

- New captured and explicitly remembered notes have a traversable responsibility trail.
- Repeated writes by the same resolved identity reuse one person note.
- `COMMONWEALTH_AUTHOR` and `COMMONWEALTH_AUTHOR_EMAIL` provide a trusted runtime override for
  shared machines and automation.
- Email is used only to derive a one-way identity key; automatic contributor notes do not publish
  the plaintext Git email.
- Historical notes are unchanged; backfilling them requires a separately auditable migration.
