# 31. Project identity is resolved at read time; provenance is immutable

- Status: Accepted
- Date: 2026-07-16
- Deciders: kristof (owner)
- Relates: [ADR-0003](0003-concurrency-model.md) (derived-file discipline),
  [ADR-0015](0015-note-project-provenance.md) (the `source` provenance this builds on),
  [ADR-0005](0005-search-and-embeddings.md) (derived/disposable),
  [ADR-0029](0029-person-responsibility-attribution.md) / #233 (person links — same identity family),
  #239, #152/#150 (non-dev surfaces this feeds)

## Context

`source` (ADR-0015) does two jobs at once: it records **where** a note was captured (the git
`origin` slug for a repo, the folder basename otherwise) AND, because every grouped surface keys on
it, it is treated as **what the note is about**. One real-world engagement therefore fractures into
unrelated "projects": a customer's dev repo `weareantenna/acme-website` and their business folder
`Acme Website` render as two sections in `COMMONWEALTH.md`, two health rollups, two subtrees. As
non-dev workspaces arrive (plain folders, frequently with no git and a fragile basename like
"Documents"), *every* engagement fractures this way by default.

Retrieval already crosses the divide — per-prompt injection (`selectRelevant`) does not scope by
source. The missing piece is IDENTITY, not search plumbing. And the fix must not violate the
core invariants: notes are immutable-ish (create/supersede, never rewrite history — ADR-0003 §3),
and `source` must stay honest provenance.

## Decision

Separate engagement **identity** from capture **provenance**, and resolve identity at READ time from
two inputs feeding one resolver. Notes are never rewritten to merge sources.

1. **Provenance stays immutable.** A note's `source` (ADR-0015) is never changed and the on-disk
   layout stays `<source>/<kind>/<id>.md`. No file moves.

2. **Identity has two declared inputs, one resolver.**
   - **Manifest (save-time, primary).** A `.commonwealth/project.json` in the working folder/repo —
     `{ "project": string, "customer"?: string }` (unknown keys ignored; a `members` key from the
     future wizard is tolerated, not processed). Present → capture stamps the note's `project`
     frontmatter (and the customer as a `customer:<slug>` TAG, not new frontmatter — tags already
     exist and are searchable, keeping the schema surface small). `resolveProjectManifest` walks up
     from cwd to the nearest manifest, never above the enclosing git repo's root (or filesystem root
     for a non-git folder). Never throws; a present-but-malformed manifest is treated as absent after
     ONE stderr breadcrumb (the loud-corrupt-config lesson, #210).
   - **Alias map (read-time, retroactive/corrective).** A versioned, curator-editable, synced-with-
     the-brain `<brain>/.commonwealth/projects.json`: `{ "<projectId>": { "customer"?, "sources": [...] } }`.
     Loaded with the same defensive discipline as brain config (corrupt → breadcrumb + treated as
     absent for READS); WRITERS refuse to overwrite a corrupt file (backup + throw — the #78
     `persistRegistry` pattern).

3. **Resolution order** (`resolveNoteProject(note, aliasMap)`, pure): the note's own `project`
   frontmatter → an alias-map entry whose `sources` contains the note's `source` → the `source`
   itself as a singleton project (today's default, unchanged). A note whose frontmatter `project`
   and the alias map disagree: frontmatter wins, with no read-time warning (write-time already had
   its say). A note with neither `project` nor `source` is unattributed.

4. **The alias map is a DERIVATION INPUT, exactly like brain config** (ADR-0003/0005). All derived
   surfaces group/label by RESOLVED project: `COMMONWEALTH.md` renders one section per engagement,
   listing each member `source` as a `### <source>` provenance subhead when more than one source is
   unioned (a single-source project renders flat, byte-identical to the pre-ADR-0031 router); the
   health rollup gains a per-resolved-project breakdown. Linking two sources reorganizes every view
   with **zero note edits**, and rebuild-from-files stays byte-deterministic (the map is an input).

5. **Confirmation over inference.** Linking is only ever an explicit act — a manifest declaration,
   a curator edit, or the `commonwealth project link/unlink/list` CLI. There is NO fuzzy or
   name-similarity auto-merge anywhere: a wrong silent merge of two similarly-named customers is
   worse than no merge.

## Consequences

- Retroactive for free: linking a dev repo and a business folder reorganizes `COMMONWEALTH.md` and
  the health rollup without touching a single note file; unlinking restores the per-source view.
- Provenance stays trustworthy — `source` still answers "where did this come from?" — while identity
  answers "which engagement?". The two never overwrite each other.
- Additive schema: `project` is one optional frontmatter field. A note without it is unchanged on
  disk; brains with no manifest and no alias map behave exactly as before (source-as-singleton).
- Physical INDEX.md files stay per-`source` directory (the layout is unchanged by design), so the
  single grouped router lives in `COMMONWEALTH.md`; per-directory indexes remain provenance-honest
  listings.
- Trade-off accepted: identity resolution reads one extra small file (`projects.json`) during
  derivation and capture. It is cached-free and tiny, and it preserves the "derived is a pure
  function of (files + config-like inputs)" property that makes sync conflict-free.

## Follow-ups (out of scope here, filed against #239)

- Search/filter by resolved project and a same-project injection boost in `selectRelevant`.
- Graduation grouping by resolved project.
- The conversational new-project wizard that WRITES the manifest (this ADR is the layer it consumes).
- `commonwealth map` visualization beyond the basic per-project grouping.
