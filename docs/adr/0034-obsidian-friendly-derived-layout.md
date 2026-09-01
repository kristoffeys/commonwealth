# 34. Obsidian-friendly derived layout: per-project MOCs, wikilinks, shipped vault config

- Status: Accepted
- Date: 2026-08-28
- Deciders: kristof (owner); Claude (orchestrator, proposer)
- Relates: [ADR-0003](0003-concurrency-model.md) (derived files are regenerated, never hand-merged —
  the invariant this change stays within), [ADR-0015](0015-project-provenance-layout.md) (the
  per-project `<source>/<kind>/` layout the MOCs sit on top of), [ADR-0031](0031-project-identity-resolved-at-read-time.md)
  (the alias map that names a MOC after its business name)

> A Commonwealth brain is plain markdown in a git repo, so a teammate can open it directly in
> Obsidian. Until now the derived index was a `COMMONWEALTH.md` router plus one `INDEX.md` in every
> notes folder — which rendered as dozens of identical **"INDEX"** nodes in Obsidian's graph and made
> the vault illegible. This ADR reshapes the *derived* layer (canon is untouched) so the vault reads
> as a knowledge graph.

## Context

The derived artifacts (`regenerateDerived`) are disposable, regenerated-from-canon files (ADR-0003).
Their previous shape optimized for the agent-facing router and a per-folder file listing, not for a
human opening the folder in Obsidian:

- **70+ files all named `INDEX.md`.** Obsidian labels graph nodes by filename, so every project's
  per-kind index collapsed into indistinguishable "INDEX" hubs — the user's original complaint.
- **No relationship edges.** `superseded_by` / `supersedes` / `relates` are plain-string frontmatter,
  which core Obsidian does not graph. The knowledge structure (a decision → the memory it replaced)
  was invisible.
- **`"INDEX.md"` was hardcoded as the "this is derived" marker** in verify (byte-identical check), the
  sync secret-scrub, the daemon watch-ignore, and doctor's sync-debt accounting — an implicit,
  duplicated contract.

Constraint: **canon must not change.** Note bodies and frontmatter stay one-fact plain markdown, so
non-Obsidian consumers (the MCP server, `emit`, other editors) are unaffected. Everything here lives
in the regenerated derived layer.

## Decision

1. **Per-project MOC (Map of Content) named after the project.** Replace the per-kind `INDEX.md`
   files with **one derived note per project**, at the project-folder root
   (`<source-segment>/<Name>.md`, e.g. `weareantenna-spardex/Spardex.md`). It lists the project's
   notes under kind sections, so the graph shows a single readable `Spardex` node wired to its notes
   instead of several "INDEX" nodes. `Name` prefers the ADR-0031 alias `customer` name, else the last
   path segment of the source with a leading capital. The MOC sits at the folder root — parent is not
   a kind folder — so note discovery never mistakes it for a note (no skip rule needed). Unattributed
   notes carry no MOC; they surface in `COMMONWEALTH.md` only.

2. **Wikilinks + a Relations section (derived-only).** MOCs and the `COMMONWEALTH.md` hub link notes
   as `[[id|title]]` wikilinks (graph edges), and each MOC renders a **Relations** section turning
   `supersedes`/`relates` into `[[a]] → [[b]]` edges. This makes supersession and provenance visible
   in the graph *without* putting Obsidian syntax into canon frontmatter — the relations are rendered
   from the plain-id fields at generate time.

3. **One structural "derived file" predicate.** `isDerivedMarkdownFile(relPath)` in core is the single
   source of truth: a note is any `.md` whose parent folder is a kind folder, so *any other* tracked
   `.md` (the root hub, or a MOC at a project-folder root) is derived — except `README.md` at any
   depth, which is user-owned (scaffolded absent-only, then never regenerated, pruned, or diffed).
   verify, the sync secret-scrub,
   the daemon watch-ignore, and doctor all key off it, replacing the hardcoded `"INDEX.md"` matching.
   `regenerateDerived` **prunes** stale derived files and legacy `INDEX.md`, so an older brain
   auto-migrates on its next regenerate and a removed/renamed project leaves no orphan node.

4. **Ship a starter `.obsidian/` vault config.** `initBrain` writes (absent-only) an Obsidian graph
   config that filters out derived/local dirs (`staging/`, `index/`, `.commonwealth/`) and colors
   nodes by kind, plus readable line length. Per-user session state (`.obsidian/workspace*.json`) is
   gitignored; the shared view config is committed so the whole team sees the same graph.

## Consequences

- **Good:** opening a brain in Obsidian is immediately legible — hub → project MOCs → notes → people,
  colored by kind, with supersession edges. The derived-file contract is now explicit and centralized.
- **Cost:** a one-time reshuffle of the derived layer in existing brains (regenerate + prune;
  no canon change). The secret-scrub predicate now over-scans (any non-note root `.md`), which is the
  safe direction for a leak gate.
- **Not done (deliberate):** true note↔note frontmatter links would require storing `[[id]]` in canon
  frontmatter (a schema-contract change touching every id consumer) — deferred; the derived Relations
  section delivers the graph edges without it. Note filenames remain id-slugs (required by the
  concurrency model); showing titles as node labels needs the community *Front Matter Title* plugin,
  documented as optional rather than shipped.
