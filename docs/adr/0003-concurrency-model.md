# 3. Concurrency: atomic files + union merge + derived indexes + scoped queue

- Status: Accepted
- Date: 2026-07-01
- Deciders: kristof (owner), Claude (orchestrator)
- Relates: [architecture §2](../01-architecture.md), GitHub issues #2, #7, #8

## Context

Concurrency is where every competitor is weakest: basic-memory does mtime-wins silent
overwrites; whole-file rewriters (Cline) are merge-conflict-prone; GBrain sidesteps it
by being single-player. For a multiplayer git-backed brain this is *the* hard problem
and the moat. We want to **avoid** conflicts by design, not merely resolve them.

## Decision

Four mechanisms, in priority order:

1. **Atomic, append-only notes — one fact per file**, named `<date>-<slug>-<shortid>`
   (shortid = short hash). Concurrent writers create distinct files → git unions them →
   no conflict. This is the primary mechanism.
2. **Derived, never-hand-merged indexes.** `COMMONS.md`, per-folder `INDEX.md`, backlinks
   are regenerated from the note set (idempotent). Backstopped by a `merge=union`
   `.gitattributes` driver on append-only files.
3. **Scoped write queue for the rare true edit.** Editing an existing note serializes
   through the daemon (acquire → rebase → apply → push → retry) and prefers
   section-scoped `append`/`insert` over whole-file rewrites.
4. **Never silently overwrite.** A genuine same-file conflict writes both versions as
   sibling notes and files a `conflict:` curation task.

## Consequences

- The common path (new atomic note) is conflict-free with zero coordination.
- High-contention index files never require a manual merge.
- A little more machinery (queue, conflict tasks) only where edits actually collide.
- Requires a discipline: writers create/supersede notes rather than editing in place
  where possible. Enforced in the note-IO API.

## Alternatives considered

- **mtime-wins (basic-memory)** — rejected: silent data loss.
- **CRDT layer (basic-memory Cloud, Relay)** — powerful but pulls us off pure git and
  toward a proprietary sync protocol; conflicts with the ownership thesis.
- **git-notes/refs (Mainline)** — not human-editable markdown; loses the browse/PR story.
