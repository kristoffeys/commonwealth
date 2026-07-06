---
title: Architecture
type: decision
status: draft
updated: 2026-07-01
tags: [architecture, concurrency, sync, mcp]
---

# Architecture

The whole system rests on three decisions, in order of how much they define the product:

1. **Git is the substrate** — not a database with git export.
2. **Concurrency is designed out, not resolved** — atomic files + derived indexes.
3. **The "auto" bridge is the product** — capture → curate → commit → propagate.

## 1. Git is the substrate

The brain _is_ a git repository of markdown. No proprietary store is the source of
truth — that is the ownership and portability guarantee: your knowledge stays in files you
own, not an opaque index or a block database you can't leave.

- **One repo per project brain.** `acme-brain`, `internal-brain`, etc. A team may also
  have an `org-brain` for cross-project knowledge. (Monorepo-of-brains is a later option;
  per-project repos keep permissions and blast radius simple.)
- **Remote = any git host.** GitHub by default (fits our OSS + Projects workflow), but
  the design must not assume GitHub-only. Self-host / BYO-remote is first-class.
- **A local working copy** lives on each member's machine (e.g. `~/.commonwealth/<brain>`),
  kept in sync by the daemon (below). The agent reads/writes the local copy; the daemon
  moves commits to/from the remote.
- **A derived index** (SQLite + embeddings) is built _from_ the markdown for fast
  search. It is disposable and `.gitignore`d — rebuildable from files at any time
  (basic-memory's model, and the right one).

```
acme-brain/                      # a git repo = one project's brain
├── memory/                      # atomic notes (append-heavy, rarely collide)
│   ├── 2026-07-01-auth-choice-a1b2.md
│   └── 2026-06-30-client-billing-quirk-9f3d.md
├── decisions/                   # ADR-style, one file per decision
├── work-state/                  # current status per workstream
├── people/                      # people-threads: one file per person/relationship
├── index/                       # DERIVED, gitignored (SQLite + vectors)
├── .commonwealth/                    # config: schema version, curation rules, remotes
└── COMMONWEALTH.md                   # human+agent entry point (the router / TOC)
```

## 2. Concurrency: design it out

Concurrency is where most shared-memory tools are weakest — mtime-wins overwrites,
whole-file rewrites that conflict, or simply being single-player. We don't want to _win_
merge conflicts — we want to **not have them**.

Three mechanisms, in priority order:

### a) Atomic, append-only notes — one fact per file

Following the pattern that already works in personal setups (Claude's own
one-fact-per-file memory): each note is a **small, self-contained markdown file** with a
**collision-proof name** (`<date>-<slug>-<shortid>`, shortid = content/uuid hash). Two
teammates writing "at the same time" create two _different_ files. Git merges them as a
**union** — no conflict, ever. This is the single most important concurrency decision.

### b) Derived, never-hand-merged indexes

`COMMONWEALTH.md`, per-folder tables of contents, backlink graphs, roll-ups — all
**regenerated from the note files**, not hand-edited. So the high-contention "index"
file is never the subject of a manual merge. Two strategies, combined:

- Regenerate on the daemon after every pull (idempotent from the file set).
- Register a **git merge driver** (`merge=union` via `.gitattributes`) for the append-
  only index files as a backstop, so even a raw merge unions cleanly.

### c) A serialization queue for the rare true edit

Editing an _existing_ note (a correction, a decision superseded) can still collide. For
those:

- **Section-scoped edits, not whole-file rewrites.** Prefer `append` / `insert-section`
  ops over rewriting the file (Letta's `memory_insert` is safe; `rethink` is lossy).
- A lightweight **write queue** in the daemon serializes commits to the _same file_:
  acquire → pull/rebase → apply → push, with retry. This is the "queueing mechanism"
  from the brief, scoped down to only where it's actually needed (same-file edits),
  not every write.
- On genuine conflict, **never silently overwrite**. Write both versions as sibling notes
  and file a `conflict:` curation task for review.

**Net:** ~all writes are new atomic files (conflict-free unions); indexes are derived
(no manual merges); only same-file edits touch the queue, and even those degrade to a
reviewable task rather than data loss.

## 3. The "auto" bridge — capture → curate → commit → propagate

Storage is solved; the unsolved problem (per the research) is the _auto_ pipeline:
turning session learnings into shared, curated, propagated knowledge. This is the
product. It runs in four stages, wired into Claude Code lifecycle hooks + MCP.

```
 session ──▶ CAPTURE ──▶ CURATE ──▶ COMMIT ──▶ PROPAGATE ──▶ next session
 (learnings)  (draft     (dedupe,   (atomic    (push +        (pull +
              notes)     verify,    file +     open PR /      inject relevant
                         gate)      queue)     review)        context)
```

### Capture (Stop / SessionEnd hook + MCP write tools)

- The agent proposes candidate memories from the session (decisions made, gotchas
  learned, work-state changes). Two paths: explicit MCP `remember` calls during the
  session, and an end-of-session sweep that drafts notes.
- Candidates land in a **staging area** (`staging/`), not straight into canon.

### Curate (curation gate, runs on staging + nightly)

- **Dedupe** against existing notes — lexical, plus optional embeddings (`semanticDedup`).
- **Verify** where possible — check memory against reality (e.g. a claim about code vs. the
  actual code). Mark `verified:` / `stale:`.
- **Contradiction check** — flag notes that conflict with canon; open a review task.
- **Relevance gate** — score whether a candidate is worth committing/sharing at all
  (avoid junk accumulation). Low-value → drop; high-value → promote.

### Commit (atomic file + queue, per §2)

- Promoted notes become atomic files, committed with a structured message.
- **Curation-as-review:** promotion opens a **PR** (or a review queue) so a human — or a
  higher-trust agent — approves before it becomes canon. Junk never auto-lands.

### Propagate (SessionStart hook + relevance-gated fetch)

- **Push** on commit (daemon).
- **Fetch/merge** into every teammate's local copy on session start (daemon `pull`).
- **Relevance-gated injection** — the genuinely novel bit: don't dump the whole brain
  into context; surface the notes relevant to _what this teammate is doing right now_
  (current project/files/task). This is the "auto push/fetch where it sees fit" from
  the brief, made concrete.

## Components

| Component              | Role                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Brain repo(s)**      | Git repo(s) of markdown — the substrate & source of truth                                                                                                 |
| **Sync daemon**        | Per-machine: pull on session start, commit+push on write, run the write queue, rebuild the index. Long-lived, one per user.                               |
| **MCP server**         | Exposes `search / read / remember / list-workstate / whoami`-style tools to Claude Code (and any MCP client). Reads local copy + index.                   |
| **Curation agent**     | Runs dedupe/verify/contradiction/relevance on staging + nightly (cron), opens review PRs. Can reuse Claude via the Agent SDK.                             |
| **Claude Code plugin** | Bundles MCP server config + lifecycle hooks (SessionStart pull+inject, Stop capture) + the brain registry. The auto-provisioning unit (see distribution). |
| **Brain registry**     | Maps a working directory / project → its brain repo(s), so the plugin mounts the right brain automatically.                                               |

## Decisions of record

The concrete choices behind the above — embeddings (local-first, opt-in), the review-gate
default, secret scanning, clone-on-demand access, and more — live as
[Architecture Decision Records](adr/). Cross-brain graduation (project → org brain) is the main
open thread; see the [roadmap](04-roadmap.md).

See [`docs/02-data-model.md`](02-data-model.md) for the note schema and
[`docs/03-distribution.md`](03-distribution.md) for how the plugin auto-provisions.
