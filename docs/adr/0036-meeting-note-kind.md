# 36. A fifth note kind: `meeting` (paste-and-summarize, hybrid extraction)

- Status: Accepted
- Date: 2026-09-01
- Deciders: kristof (owner)
- Relates: [ADR-0003](0003-concurrency-model.md) (atomic one-fact-per-file notes; derived files
  regenerated), [ADR-0007](0007-curation-review-gate.md) (staging queue + gates every write passes),
  [ADR-0020](0020-ask-the-brain-agent-synthesis.md) (the host agent synthesizes; Commonwealth stores)

## Context

Teams generate a lot of their most valuable knowledge in meetings, and increasingly capture it as raw
material — a Plaud pocket-recorder export, a call transcript, or pasted notes. Today that raw material
has nowhere to land: our four kinds (`memory`, `decision`, `work-state`, `person`) are all small
atomic facts, and a 40-minute transcript is neither atomic nor a single fact. Users either drop the
whole blob into a `memory` note (violating one-fact-per-file, polluting search, and burying the real
decisions) or hand-shred it themselves (high-friction, lossy — the original is discarded).

We want a paste-and-summarize flow: a user pastes the raw meeting, and the brain both keeps a clean
record of the meeting AND surfaces the decisions and action items inside it as first-class atomic
notes that show up in the decision log and the work-state list.

There is a real tension with our core "one fact per file, atomic notes" principle (ADR-0003): a
meeting is not one fact. Two shapes were considered:

- **Extract-only** — shred the meeting into atomic notes and discard the transcript. Faithful to
  one-fact-per-file, but throws away the source of truth; you can never re-derive a missed decision,
  and the provenance ("this came from the Aug 31 standup") is reduced to a tag.
- **Record-only** — store one big meeting blob and stop. Keeps the source, but the decisions and
  actions stay invisible to `/commonwealth:ask`, the decision log, and the work-state list — exactly
  the queries that make the brain useful.

## Decision

Add a fifth note kind, `meeting`, and store meetings **hybrid** — both shapes at once:

1. **One immutable `meeting` record note** holds a clean structured summary (purpose, attendees,
   date, key points) with the **raw transcript folded in at the bottom** of the body. This note is an
   acceptable exception to one-fact-per-file: a meeting is an immutable *event*, and an event record
   is legitimately a single unit — it is never edited or superseded, only referenced. It is the
   durable, re-derivable source: if a decision was missed, the transcript is still there to mine.

2. **Extracted atomic notes** — each decision → a `decision` note, each action item → a `work-state`
   note (with an `owner`), each durable fact → a `memory` note. These are ordinary atomic notes,
   fully faithful to ADR-0003, and they are what powers the decision log, the work-state list, and
   cited recall. Each carries `relates: <meeting-id>` back to the record, and the meeting's own
   `relates` lists them — so the graph shows the meeting wired to everything it produced.

The **summarizing and extracting is done by the host agent** (the Claude session running
`/commonwealth:meeting`), NOT by new code — the same division of labor as `/commonwealth:ask`
("host synthesizes, Commonwealth stores", ADR-0020). New code is only the schema, the CLI plumbing,
and the command prompt that instructs the host.

Schema/plumbing specifics:

- `MeetingFrontmatter` adds `meeting_date` (required `YYYY-MM-DD`), `attendees` (string array,
  defaults `[]`), and optional `source_type` (`plaud` | `recording` | `paste` | `manual`). Cross-links
  reuse the base `relates` field — no new field. `SCHEMA_VERSION` bumps 1 → 2; the bump is purely
  additive and the version gate is forward-tolerant (a v1 brain loads under a v2 build unchanged, and
  a v1 build only fails per-note — skipped, not fatal — if it meets a v2 meeting note).
- The meeting record is staged through the **same curation gates as every other write** (ADR-0007):
  the transcript is secret-scanned and dedup-checked. A large Plaud transcript exceeds shell ARG_MAX,
  so the curate CLI's `stage` command reads the body from **STDIN** (`--body -`); it is piped, never
  placed on argv.

## Consequences

- Meetings become a native, queryable part of the brain: the record is browsable and re-mineable,
  while the decisions and actions inside it are indistinguishable from any other atomic note in the
  decision log, the work-state list, and cited recall.
- One-fact-per-file is preserved where it matters (the extracted notes) and consciously relaxed only
  for an immutable event record — a bounded, justified exception, not a general licence for blobs.
- The transcript is secret-scanned like any staged content; a meeting that trips the gate is held,
  not silently stored.
- `NoteKind` gains a fifth member, so every exhaustive consumer (the `KIND_DIR` map, the brain-map
  per-kind rollup, the per-project MOC sections) now lists Meetings; kind-specific narrowing
  (supersede, reclassify, consolidate) deliberately ignores `meeting` and does not throw on it.
- Trade-off accepted: extraction quality depends on the host agent's summary, exactly as `ask` and
  `decide` already do. The raw transcript in the record is the backstop — a missed decision can always
  be recovered from it.
