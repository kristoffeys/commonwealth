# 35. Physical layout keys off the resolved project

- Status: Accepted
- Date: 2026-09-01
- Deciders: kristof (owner)
- Supersedes: [ADR-0031](0031-project-identity-resolved-at-read-time.md) §1 ("Provenance stays
  immutable … the on-disk layout stays `<source>/<kind>/<id>.md`. No file moves.") — the "no file
  moves / layout stays keyed off `source`" stance is reversed here.
- Amends: [ADR-0015](0015-note-project-provenance.md) — the per-project folder key changes from the
  raw `source` to the RESOLVED PROJECT. `source` stays in frontmatter as provenance; it stops being
  the folder key.
- Relates: [ADR-0003](0003-concurrency-model.md) (derived-file discipline, never-overwrite),
  [ADR-0005](0005-search-and-embeddings.md) (derived/disposable)

## Context

ADR-0031 introduced a project-identity layer — a note's engagement is resolved at read time from its
`project` frontmatter, then the brain's `projects.json` alias map, then its `source` as a singleton —
but it deliberately grouped only DERIVED views (`COMMONWEALTH.md`, the health rollup, the MOCs) and
promised "no file moves": the physical tree stayed keyed off the raw `source`, so one logical project
split across several repos still scattered into several top-level `<source>/` folders.

That split-across-repos folder tree is the remaining pain. A reader browsing the brain (or Obsidian's
file tree, ADR-0034) sees `weareantenna/acme-website/` and `Acme Website/` as two unrelated top-level
folders for one engagement, even though every grouped view already unifies them. The identity is
resolved; only the bytes on disk lag.

## Decision

Key the physical folder tree off the RESOLVED PROJECT, so all repos of one engagement live under one
`<project>/<kind>/` folder. Provenance is preserved — `source` stays in frontmatter; it just stops
being the folder key.

1. **New notes file under their project.** `writeNote` computes the folder segment from
   `input.project ?? input.source` (was: `input.source`). A note that declares a `project` files under
   `<project>/<kind>/<id>.md`; a source-only note is unchanged (`<source>/<kind>/…`); an unattributed
   note still lives at the kind root. Promotion from `staging/` (`review.approve`) mirrors this, and
   capture/stage resolve the alias-map project for a NEW note so a note from a LINKED repo also lands
   under `<project>/` even without a manifest (precedence: explicit `project` → manifest → alias-map
   link → none).

2. **Derived grouping follows the physical key.** `regenerateDerived` groups notes by
   `sourceSegment(resolveNoteProject(note))` — the same key the layout uses — so exactly one MOC is
   emitted per project folder.

3. **Existing notes move only via an explicit `relayout`, never automatically.** `commonwealth project
   relayout [projectId] [--dry-run]` MOVES each canon note whose current top folder differs from its
   target project segment to `<project>/<kind>/<id>.md`, stamping `project:` into its frontmatter
   (self-describing, so future writes stay stable even if the alias map later changes). It is
   single-writer (sync lock), snapshot-driven, idempotent (a second run moves nothing), lossless (note
   count invariant), and **fails closed** on a destination collision (link-not-rename, raising
   `NoteIdCollisionError` before touching anything — ADR-0003's never-overwrite). It regenerates
   derived and sweeps now-empty source folders, never touching `.commonwealth/`, `staging/`, `index/`,
   or `.git/`. `--dry-run` prints the planned moves and changes nothing.

## Consequences

- The folder tree becomes identity-organized: one engagement, one folder, however many repos feed it.
  Obsidian's file tree (ADR-0034) and a plain `ls` now match what every grouped view already showed.
- Provenance stays trustworthy — `source` still answers "where did this come from?"; it is simply no
  longer the folder key. Moving a note preserves its `source` verbatim.
- Moves are explicit. Capture/promote file NEW notes correctly with no migration; EXISTING notes move
  only when a human runs `relayout`, so the reorganization is a chosen, reviewable event (one commit on
  a git brain), never a silent mass rewrite on read.
- Trade-off accepted: the physical layout now depends on the alias map, a derivation input that can
  change. We keep the two in sync deliberately — `relayout` stamps `project` onto each moved note so its
  home no longer depends on the map, and re-running `relayout` after a later link is the explicit way to
  reconcile. A note whose map link changes but which is never relay'd stays where it is (its declared
  frontmatter, or its old source folder) until the next explicit pass — no automatic churn.
