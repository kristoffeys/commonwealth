# 15. Notes carry project provenance and are laid out per-project

- Status: Accepted
- Date: 2026-07-02
- Deciders: kristof (owner), Claude (orchestrator)
- Relates: [ADR-0003](0003-concurrency-model.md), [ADR-0005](0005-derived-index.md),
  [ADR-0011](0011-brain-wiring-global-registry.md), [data-model](../02-data-model.md), issue #90

## Context

A single brain is shared across many projects: every repo under a registry `prefix` maps to
one brain (ADR-0011) — e.g. all `antenna-*` repos → `antenna-brain`. Until now notes were
organized only by *kind* (`memory/`, `decisions/`, `work-state/`, `people/`) with **no record
of which project a note came from**. You could not ask "show me everything from o2o-platform",
and the router (`COMMONWEALTH.md`) mixed every project together. The only project signal was
incidental text an extraction agent happened to put in a title.

## Decision

1. **Provenance is first-class metadata.** Add an optional `source` field to every note's base
   frontmatter — a stable project identity: the git `origin` remote reduced to an `owner/repo`
   slug, else the repo-root basename, else the cwd basename (`resolveProjectSource`). It is
   optional; pre-existing and non-project notes are "unattributed".
2. **The on-disk layout is per-project: `<project>/<kind>/<id>.md`.** A note with a `source`
   lives under a per-project subtree; an unattributed note stays at the kind root
   (`<kind>/<id>.md`), which is also the back-compat location. The project folder is a single
   filesystem-safe segment derived from `source` (separators flattened); the full `source`
   stays in frontmatter. The owner chose project-first subtrees over flat-with-metadata so each
   project is a self-contained, browsable tree.
3. **Kind is authoritative from frontmatter, not the folder.** `listNotes` walks the tree and
   identifies a note by (parent folder is a kind folder) + (not `INDEX.md`), then filters by
   `frontmatter.kind`. This decouples the layout from kind-detection, so the same code works for
   both flat and per-project paths and future layout tweaks don't ripple.
4. **Capture stamps `source` automatically.** The SessionEnd hook already passes the session
   `cwd`; `curate capture` resolves the project from it and stamps each candidate. MCP `remember`
   resolves it from the MCP process cwd. `approve()` promotes a staged note into the same subtree.
5. **Grouping/filtering is a derived/query concern (disposable, ADR-0005).** `search` gains a
   `source` filter and returns `source`; `COMMONWEALTH.md` is regenerated grouped by project
   (a section per source, unattributed last); an `INDEX.md` is written in every note-bearing
   directory.
6. **The secret scrub stays layout-agnostic.** A file is a note (and thus scanned) when its
   immediate parent folder is a kind folder — covering both `<kind>/x.md` and
   `<project>/<kind>/x.md` — so per-project paths never slip past the pre-commit secret gate.

## Consequences

- Concurrency is unaffected (ADR-0003): notes are still atomic one-fact-per-file with
  collision-proof ids; per-project folders union-merge exactly as flat folders did.
- Existing brains keep working: notes without `source` stay flat and read/search/scrub normally;
  new captures get a project subtree. No migration is required (backfill is optional).
- The derived index and `COMMONWEALTH.md`/`INDEX.md` are regenerated, never hand-merged, so the
  grouping is fully rebuildable from the note set.
- Trade-off accepted: project-first subtrees required teaching `listNotes`/derived generation and
  the secret scrub to be layout-agnostic (parent-folder-is-kind) rather than assuming a fixed set
  of top-level kind folders. Done once, centrally.
