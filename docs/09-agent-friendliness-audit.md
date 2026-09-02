---
title: Agent-friendliness self-audit
type: reference
status: draft
updated: 2026-09-02
tags: [audit, mcp, cli, concurrency, agent-parity]
---

# Agent-friendliness self-audit

Commonwealth's pitch is that it's the layer a coding agent can read and write without a
human in the loop. This audit holds that claim to the same bar we'd apply to any API we
expect agents to drive: can an agent discover what's there, act on it without re-deriving
context every turn, get an actionable error when it gets something wrong, preview a write
before committing it, and trust that a concurrent writer won't silently eat its work?

Eight dimensions were checked. Three hold up exactly as designed (whole-object edits,
persisted drafts, testability — see [What already holds](#what-already-holds)); concurrency
mostly holds but has one real, verified gap in the exact mechanism that's supposed to make it
safe; the rest — capability asymmetry, validation ergonomics, schema discovery, dry-run
coverage, and one genuine terminology collision — are concrete findings below. Every claim
cites `path:line`; none of it is inference from prose.

## Findings, ranked by leverage

| id | dimension | verdict | severity | fix size |
| --- | --- | --- | --- | --- |
| [F1](#f1-supersede-races-unlocked-on-the-exact-path-that-claims-conflict-free) | concurrency | **fails** on one path | high | S |
| [F2](#f2-capability-asymmetry-curation-has-no-mcp-tool-surface) | capability asymmetry | fails | high | M |
| [F3](#f3-validation-surfaces-one-error-as-a-flat-string) | validation ergonomics | fails | medium | S |
| [F4](#f4-schema-discovery-is-prose-not-derived-from-code) | queryable schema | fails | medium | S |
| [F5](#f5-no-dry-run-for-the-write-that-matters) | dry-run / preview | partial | medium | S |
| [F6](#f6-source-means-three-different-things) | terminology | fails (1 term) | low-medium | S |
| [F7](#f7-the-parity-doc-overclaims-mcp-curate-coverage) | doc accuracy | fails | low | XS |

Non-issues, proven rather than asserted, are in [What already holds](#what-already-holds).

---

### F1 — Supersede races unlocked, on the exact path that claims "conflict-free"

**Symptom.** Two ordinary, expected-to-be-concurrent operations — a `SessionEnd`/`Stop`
capture sweep from one teammate's session and the same sweep (or a `/commonwealth:reclassify`
pass) from another, both touching the same shared local checkout — can silently lose one
side's supersession of a canon note. No error, no conflict marker, no sibling file: the
loser's `status`/`superseded_by` write is simply overwritten.

**Evidence.**
- `packages/core/src/notes.ts:195-210` (`supersedeNote`) reads a note, computes new
  frontmatter, then calls `overwriteNote` — a classic read-modify-write with no lock held
  across the read and the write.
- `packages/core/src/notes.ts:179-186` (`overwriteNote`) writes via `fs.rename(tmp, absPath)`
  — atomic as a syscall, but unconditional: it always replaces whatever is currently at
  `absPath`, unlike `writeNote`'s `fs.link` + `EEXIST` guard (`notes.ts:157-169`) which fails
  closed on collision. There is no equivalent guard here.
- `packages/curate/src/capture.ts:94-200` (`captureCandidates`) calls `supersedeNote` at line
  197 with **no lock acquired anywhere in the function**. This is the function behind:
  - the CLI `capture` command the `SessionEnd`/`Stop` hook shells out to
    (`packages/curate/src/index.ts:528`, comment at line 534: "the SessionEnd hook counts
    these lines"),
  - the MCP `remember` tool (`packages/mcp/src/tools.ts:143`),
  - `/commonwealth:reclassify` (`packages/curate/src/reclassify.ts:163`, which explicitly
    constructs a `supersedes` verdict at lines 156-160).
- Contrast: `packages/curate/src/consolidate.ts:114-116` acquires the exact same
  `acquireSyncLock` (`packages/core/src/lock.ts:61-85`) for its **entire** pass before calling
  `supersedeNote` at line 136, and cleanly reports `skipped: "another writer holds the sync
  lock"` if contended rather than racing. `graduate.ts:203,281` and `adopt.ts:207` do the same
  for their own mutations. `capture.ts` is the one caller of `supersedeNote` that doesn't.

**Root cause.** The lock (`acquireSyncLock`) exists and is used correctly by three of four
mutators of existing notes; the fourth — `captureCandidates`, which is the single most
frequently exercised write path in the whole system, hit on every session end and every
`remember` call — was never wired to it. ADR-0032's argument that "an uncoordinated
commit/pull-rebase/push from each session is safe without any daemon-side queue" is true for
**new** atomic files (union-merge handles those); it does not cover this in-place mutation,
and nothing currently enforces the difference.

**Cost to an agent.** None of this is visible to the agent that loses the race — no error,
no rejected write. A supersession an agent made (or that a teammate's agent made) simply
doesn't take effect, and the two "who superseded this" facts silently collapse into one. This
is the literal failure mode ADR-0003 exists to design out ("never silently overwrite"), and
it's on the default, `autoPromote`-on path — not an edge case behind a flag.

**Fix sketch.** Wrap the `supersedesById` loop in `captureCandidates`
(`packages/curate/src/capture.ts:187-200`) in the same `acquireSyncLock`/`release` pattern
already proven in `consolidate.ts:114-149`. On contention, defer the affected supersession
into the existing `conflict:`-task path (ADR-0003 mechanism 4) rather than silently dropping
it, so a genuine race becomes a reviewable note instead of data loss. Small: one call site,
one existing primitive, no new abstraction. Needs a concurrency test (two interleaved
`captureCandidates` calls targeting the same note) — the kind of test this repo already
requires for concurrency-sensitive paths.

---

### F2 — Capability asymmetry: curation has no MCP tool surface

**Symptom.** Of 26 top-level CLI verbs (`packages/cli/src/index.ts:246-326`), 6 MCP tools
(`packages/mcp/src/server.ts`), and 7 Claude-Code-only slash commands
(`packages/plugin/commands/*.md`), the entire curation lifecycle — the part of the product
this repo's own principles call "review-capable" — is reachable through MCP only via
**prompts**, not tools, and much of it isn't reachable via MCP at all.

**Evidence.**
- MCP **tools**: `search` (`server.ts:97`), `ask` (`:121`), `read` (`:157`), `remember`
  (`:182`), `list-work-state` (`:223`), `who-is` (`:241`). 6 total.
- MCP **prompts** (`packages/mcp/src/prompts.ts:66,100,126,165,218,241`, registered
  `server.ts:268-279`): `ask`, `recall`, `remember`, `decide`, `status`, `promote`. These are a
  *different* MCP primitive from tools — most MCP clients surface prompts as user-selected
  templates, not something a model can invoke on its own initiative mid-task the way it calls
  a tool. So `promote` and `decide` are technically MCP-reachable, but only through a
  mechanism an autonomous agent generally can't drive itself, and that plenty of MCP clients
  (anything not implementing the prompts capability) don't expose at all.
- CLI verbs with **no MCP tool and no MCP prompt**: `reject`, `pending`, `consolidate`,
  `graduate`, `scope`, `config`, `doctor`, `sync`, `health`, `map`, `project`, `org-brain`,
  `registry`, `emit`, `service`, `update`, `reseed`, `add`, `init`, `demo`, `statusline`,
  `verify-restore` — from the 26-verb switch in `packages/cli/src/index.ts` (verbs listed
  246-326). Of these, `reject`, `pending`, `consolidate`, `graduate`, `scope`, `config`,
  `status`/`doctor` are the ones an autonomous curation loop would plausibly need to drive
  itself (approve/reject staged notes, check what's pending, dedupe canon, promote to
  org-brain, read/set per-brain policy) — not the install/daemon/onboarding verbs (`init`,
  `add`, `service`, `update`, `demo`, `statusline`), which are legitimately human/CLI-only.
- `/commonwealth:reject`, `/commonwealth:consolidate`... don't exist either — the 7 plugin
  slash commands (`ask`, `decide`, `promote`, `recall`, `reclassify`, `remember`, `status`)
  don't cover `reject`, `pending`, `consolidate`, `graduate`, `scope`, or `config` in any
  agent-invocable form. Those are CLI-only, full stop.

**Root cause.** MCP tools were scoped to the read/write-a-note surface (ADR-0007/#9 era); the
curation pipeline (dedup, consolidate, graduate, per-brain policy) was built CLI-first and
never grew an MCP-tool face, likely because the review-gate story (ADR-0014) was designed
around a human running `/commonwealth:promote` in Claude Code specifically.

**Cost to an agent.** A Codex session, a Cursor session, or any plain-MCP client can read and
propose notes but cannot see or act on its own staged output, cannot dedupe, cannot check
brain health, and cannot read or change `autoPromote`/scope policy — it can only get there by
shelling out to `commonwealth <verb>` as raw text, which requires it to already know the CLI's
exact syntax (not discoverable via MCP's typed tool-call surface) and requires the host to
grant it a shell at all. This directly contradicts `docs/07-agent-parity.md`'s framing of
Claude Code/Codex as parity hosts sharing "one brain, registry, MCP server, curation
pipeline" (line 11) — see F7.

**Fix sketch.** Add MCP tools for `pending` (list staged, read-only, cheap), `reject`
(discard staged, has a clear undo story via git), and `config get/set` for the specific
policy flags an agent legitimately needs to read (`autoPromote`, `scope`). Leave `promote`,
`consolidate`, and `graduate` as prompts/CLI-only deliberately — these mutate canon
irreversibly-ish and are exactly the review-gated operations ADR-0014 says should have a
human or higher-trust agent in the loop; turning them into ordinary tools an agent calls
unprompted would undercut that gate. Medium: several small tools, each straightforward, but
touches the trust boundary and needs its own design pass on which one goes in as a tool vs.
which stays a reviewed prompt.

---

### F3 — Validation surfaces one error as a flat string

**Symptom.** When a candidate note fails schema validation, the agent gets exactly one error
message, not the full list of what's wrong, and it arrives as an unstructured string rather
than a field-addressable object.

**Evidence.**
- `packages/core/src/notes.ts:150` (`Frontmatter.parse(raw)`, inside `writeNote`) and `:97`
  (`parseNote`) both use zod's `.parse()`, which throws on the **first** failing field. There
  is no `.safeParse()` anywhere in the repo (repo-wide grep, zero hits) — so a candidate with
  two bad fields never finds out about the second one until it fixes the first and resubmits.
- The catch site, `packages/curate/src/curate.ts:284-288`, collapses whatever it caught into
  a single interpolated string: `` reason: `invalid: ${err.message}` ``.
- That string is the entire error surface returned to the agent — `RememberResult.reason` is
  `string | undefined` (`packages/mcp/src/tools.ts:102-114`), alongside sibling flat reasons
  `"contains-secret"`, `"duplicate"`, `"too-thin"`, `"auto-adr-disabled"`,
  `"llm-trivia"`, `"missing-contributor-identity"`.
- One code path, not two: both CLI `capture` and the MCP `remember` tool converge on the same
  `captureCandidates` → `curate` → `stageNote` → `writeNote` chain, so there's no strictness
  divergence between them (a genuine pass on that specific sub-question).
- Issue #266 (in flight, sibling PR) is reworking these flat drop-reason strings into
  structured receipts — this finding is the argument for that work, not a duplicate of it.
  Not re-specifying the fix here.

**Cost to an agent.** A malformed `remember` call becomes a fix-resubmit-fix-resubmit loop
instead of one corrected retry, burning a turn per additional error the agent couldn't see.
Zod's `.passthrough()` on every kind schema (`schema.ts:96,110,120,134`) also means a
misspelled field name is never flagged at all — it just silently rides along as an unknown
key rather than erroring, which is deliberate (preserves forward-compatible custom keys,
`schema.ts:137-141`) but compounds the same-turn-blindness problem for a typo'd field.

**Fix sketch.** Switch the parse calls to `.safeParse()` and thread `result.error.issues`
(full list, each with `path` and `message`) into the rejection reason instead of a single
interpolated string — exactly the shape #266's structured-receipts work is already headed
toward. Small, mechanical, and should land in the same PR as #266 rather than as a second
change to the same code.

---

### F4 — Schema discovery is prose, not derived from code

**Symptom.** An agent that wants to know what fields a `memory` or `work-state` note can
carry has exactly one live source: reading `docs/02-data-model.md`. There is no MCP resource,
tool response, or JSON Schema export that reflects the zod schemas in `schema.ts`
programmatically.

**Evidence.**
- `packages/mcp/src/resources.ts:3` imports only `NOTE_KINDS, listNotes, readNote, Note,
  NoteKind` from `@cmnwlth/core` — no import of anything from `schema.ts`. Grepping
  `resources.ts` for "schema" returns nothing.
- Every resource `resources.ts` serves is markdown text (`MARKDOWN` mime, `:29`) — the brain
  map (`:32-34`), per-kind indexes (`:37-39`), individual notes (`:42-44`). None of it is a
  shape/contract description; it's rendered note content.
- The `read` MCP tool (`server.ts:157-180`) returns `frontmatter` as a plain object
  (`structuredContent: { path, frontmatter, body }`) — an agent can see one note's actual
  values, but nothing tells it which fields are required, which are enums, or what the valid
  enum values are, except by reading several example notes and guessing, or reading the docs.
- No `zod-to-json-schema` (or equivalent) use anywhere under `packages/core` or
  `packages/mcp` — it appears only in `packages/plugin` tooling for an unrelated extraction
  schema, not for note frontmatter.
- Current agreement between `schema.ts` and the docs is fine today (spot-checked: `status`
  enum values, `tags` shape, `name` requiredness all match `docs/02-data-model.md`) — but
  nothing enforces that going forward. The two are hand-kept in sync by whoever edits
  `schema.ts` remembering to also edit the doc.

**Cost to an agent.** Today: an extra doc read per unfamiliar note kind, and reliance on the
zod comments/prose staying current. Going forward: the first time someone adds a field to
`MemoryFrontmatter` without touching the docs, an agent has no way to discover it short of
`read`-ing a note that happens to already carry it.

**Fix sketch.** Add one MCP resource (or a field on an existing tool's response) that emits
the frontmatter shape per kind, generated from the zod schemas directly — either
`zodToJsonSchema(MemoryFrontmatter)` etc., or a small custom walker that reads each schema's
`.shape` and each field's `.description()` (zod supports attaching these, and `schema.ts`
already has the prose as JSDoc that could move to `.describe()` calls). Small: one new
resource, no schema redesign, and it makes the existing JSDoc comments load-bearing instead
of decorative. There's already a house pattern for exactly this class of problem —
`packages/mcp/src/prompts.ts:10-15` keeps prompt bodies in sync with
`packages/plugin/commands/*.md` via `driftAnchors` (verbatim excerpts asserted present in
both, checked by `prompts.test.ts`) precisely because hand-kept-in-sync prose was judged
risky enough to need a test. `schema.ts` vs. `resources.ts` is the same shape of risk without
the same test.

---

### F5 — No dry-run for the write that matters

**Symptom.** `remember` — the one MCP write tool, the one an agent calls most — always
executes the full curation gate and writes to `staging/` (or straight to canon if
`autoPromote` is on) before returning. There is no way to ask "what would happen" first.

**Evidence.**
- CLI verbs with `--dry-run`: `consolidate` (`packages/cli/src/index.ts:169`,
  `packages/curate/src/consolidate.ts:51,136`), `graduate` (`:170`,
  `packages/curate/src/graduate.ts:65,357`), `project ... adopt` (`:167`,
  `packages/curate/src/adopt.ts:104,185-270`).
- No `--dry-run` on `promote`/`approve` (`packages/cli/src/index.ts:299-307`) or on
  `remember`/`capture` anywhere in `packages/curate/src/capture.ts` or
  `packages/mcp/src/tools.ts` — grepped both packages, zero hits.
- MCP tool input schema for `remember` (`server.ts:184-201`) has no `dryRun` field, and
  `RememberResult` (`tools.ts:102-114`) has no preview branch — it's write-then-report, always.

**Cost to an agent.** Lower than it would be for a system without a review gate — a rejected
or staged write isn't canon yet, and can be inspected/rejected afterward. But when
`autoPromote` is on (the default, ADR-0014), `remember` can land straight in canon with no
way for the calling agent to have previewed "this will supersede note X" or "this will get
rejected as too-thin" before committing to the call. The CLI curation verbs got dry-run
because a human operator wanted to check destructive-feeling bulk operations first; the same
instinct wasn't applied to the tool an autonomous agent calls unattended.

**Fix sketch.** Add a `dryRun` boolean to the `remember` MCP tool and CLI `capture`, threaded
through `captureCandidates` to run the classify/gate/supersede-resolution logic and report
what *would* be staged/promoted/rejected/superseded, without calling `writeNote`/
`supersedeNote`. Small: the gate logic already separates "decide" from "write" reasonably
cleanly (`curate()` returns a plan before `stageNote()` executes it); this is mostly a matter
of exposing that boundary.

---

### F6 — "source" means three different things

**Symptom.** The word `source` is a genuinely overloaded identifier in the schema itself —
not just a documentation-vs-code mismatch, but three distinct meanings inside `schema.ts` and
its neighbors.

**Evidence.**
1. `source` (singular, on every note) — `packages/core/src/schema.ts:51-56`: "Originating
   project the note was captured from — a stable repo identity (git `origin` slug, else the
   repo-root basename)." Provenance of the note itself.
2. `sources` (array, memory notes only) — `schema.ts:85`: a list of cited/related note paths
   (`docs/02-data-model.md:36` example: `sources: [decisions/...]`). Citations, not
   provenance.
3. `sources` (array, on a project-alias entry) — `packages/core/src/projects.ts:24-25,
   209-210`: the set of raw `source` values (per #1) that have been merged under one resolved
   `project` identity (ADR-0031). A third concept — an identity-resolution grouping — reusing
   the same field name as #2 while meaning something closer to #1, pluralized.

An agent reading `note.frontmatter.source` (provenance), `note.frontmatter.sources`
(citations, memory-only), and `aliasEntry.sources` (identity grouping) has to hold three
different mental models for what is visually the same word, one of them differentiated only
by an easy-to-miss trailing `s`.

Secondary, milder collision: **"project"** means the code-level engagement identity everywhere
inside the repo (`schema.ts:57-65`, ADR-0031, consistently) but means the GitHub Project board
in this project's own `CLAUDE.md` ("Source of truth for tasks = the GitHub Project..."). No
collision inside the codebase itself, only at the code-docs boundary — noted for completeness,
not ranked as its own finding.

Checked and **not** a collision: `brain`/`org-brain`/registry entries (`brain` consistently
means one Commonwealth git repo; `org-brain` is a designated role, not a new noun; registry
entries are pointers, not a third kind of thing — ADR-0013, ADR-0023, `registry.ts:115-118`).
Also checked and clean: `capture`/`curate`/`promote`/`graduate` are a strict pipeline with
non-overlapping definitions (`capture.ts:75-92`, `curate.ts:30-37`, `review.ts:27-30`,
`graduate.ts:22-39`) — `promote` is used consistently for "staging → canon" whether the canon
is a project brain or the org-brain; `graduate` never means the same thing as `promote`, it
means "detect + stage across the brain boundary," which is then itself promoted. This
four-word pipeline reads as intentional, not accidental overload.

**Cost to an agent.** Low probability of outright breakage (the fields are typed and
zod-validated independently), but real friction reading code that touches more than one of
the three at once — e.g. `projects.ts`'s alias-resolution code, which handles both senses of
"source" in the same function.

**Fix sketch.** Don't rename `source` (schema/breaking-change cost is disproportionate to a
naming issue). Rename the project-alias-entry field in `projects.ts` from `sources` to
something like `sourceIds` or `matchedSources`, and add one line to each of the three JSDoc
comments cross-referencing the other two ("not to be confused with X at schema.ts:NN").
Small, no schema-version bump needed since `projects.ts`'s `sources` isn't note frontmatter.

---

### F7 — The parity doc overclaims MCP curate coverage

**Symptom.** `docs/07-agent-parity.md:19` lists "MCP search/read/write/curate — Shared
server" as a Claude Code/Codex parity row. Given F2, "curate" is not accurate as an MCP
capability for *either* host in the tool sense — `promote` is prompt-only, and
`reject`/`consolidate`/`graduate`/`pending`/`scope` aren't MCP-reachable at all. The table
also never mentions MCP **prompts** as a distinct capability, even though prompts
(`ask`/`recall`/`remember`/`decide`/`status`/`promote`, `prompts.ts:65-276`) are the actual
mechanism closing part of the multiplayer gap for non-Claude-Code editors per that same
file's own docstring (`prompts.ts:3-8`).

**Evidence.** `docs/07-agent-parity.md:19` (the claim); `packages/mcp/src/server.ts:97-259`
(the 6 actual tools); `packages/mcp/src/prompts.ts:3-8,65-276` (the 6 prompts, and their
stated purpose). Cross-referenced against F2's full verb inventory.

**Cost.** This is a documentation-accuracy issue, not a capability gap — but it's the one doc
whose entire job is to state exact capabilities per host, and it currently overstates them in
a way that would mislead someone deciding whether a non-Claude-Code integration needs to shell
out to the CLI.

**Fix sketch.** Split row 19 into two: one for the 6 MCP tools (accurate as "shared, both
hosts"), one for MCP prompts vs. the CLI-only curation verbs (accurate as "partial — see
docs/09"). Trivial edit once F2's verb inventory exists to cite.

---

## What already holds

Verified, not asserted — each with the mechanism that makes it true.

- **Atomic note creation is genuinely conflict-free.** `writeNote`
  (`packages/core/src/notes.ts:129-172`) never overwrites: it publishes via `fs.link`, which
  throws `EEXIST` on any path collision rather than silently replacing (`:161-169`), and ids
  come from `makeNoteId`'s `<date>-<slug>-<shortid>` scheme, where the shortid makes two
  concurrent writers of the same title on the same day produce distinct files (comment at
  `:124-127` states the invariant this design exists to guarantee). This is the "one fact per
  file" claim, and it holds structurally, not by convention.
- **Derived files are safe to regenerate concurrently.** `regenerateDerived`
  (`packages/core/src/index-db.ts:1223-1259`) rebuilds `COMMONWEALTH.md`/`INDEX.md` entirely
  from the current note set every time — idempotent by construction, so two processes
  regenerating from slightly different snapshots each produce a valid (if momentarily
  differently-timed) index, never a corrupt hand-merge. Backstopped by a `merge=union`
  `.gitattributes` driver (`packages/core/src/scaffold.ts:41`) if a raw git merge ever touches
  them anyway.
- **Genuine same-file git conflicts don't get silently resolved one way.**
  `resolveConflictsAsSiblings` (`packages/sync/src/conflict.ts:81-164`) keeps both sides as
  separate notes with new ids rather than picking a winner — the ADR-0003 promise, upheld,
  for the case it was actually built for (two remotes' commits landing in the same rebase).
  F1 is the gap in the picture: this mechanism protects cross-machine git-level conflicts;
  it does nothing for two local processes racing on one in-memory-then-`overwriteNote` cycle,
  because that race never reaches git.
- **Whole-object writes are the intended design, not a missed patch API.** `supersedeNote`
  (internal-only, `notes.ts:195-210`) *is* the partial-update primitive — it exists, it
  changes only `status`/`superseded_by`. It's deliberately not agent-facing: CLAUDE.md's
  principle 3 ("prefer create/supersede over in-place edits") means the agent-facing
  operation for "I want to correct a note" is legitimately "write a new note," not "patch the
  old one." No missing capability here — the audit's category assumes patch-vs-whole-object
  is a spectrum improving toward patch; here whole-object *is* the safer, intended shape.
- **No persisted-draft risk, because there's no draft state to lose.** `remember`'s write
  path is a single synchronous chain ending in `writeNote`'s atomic tmp-then-`fs.link`
  (`notes.ts:154-170`) before the MCP call returns. A crash before `link()` leaves an orphaned
  tmp file and nothing else; a crash after leaves a fully-formed staged note already
  on disk. There's no multi-turn in-memory draft this system could lose, unlike a UI form with
  autosave.
- **Agents can actually test their own changes.** `packages/core/test/notes.test.ts:20`,
  `packages/curate/test/curate.test.ts:12`, and `packages/mcp/test/tools.test.ts:20-21` all
  spin up a real `fs.mkdtemp` working directory and exercise real file I/O — grepping for
  `vi.mock`/`vi.spyOn` across every test file turns up only mocks of `console.error` and one
  deterministic-id spy (`makeNoteId`), never of `writeNote`/`readNote`/`curate`/git. `pnpm
  test` runs against real behavior, satisfying this repo's own "tests must exist for
  concurrency-sensitive paths" rule with tests that would actually catch a regression like F1
  — see the fix sketch's note that F1 needs exactly this kind of test and doesn't yet have
  one.

## Prioritized fix list

1. **F1** — wire `captureCandidates`'s supersede loop to `acquireSyncLock`, mirroring
   `consolidate.ts`. Highest leverage: small, mechanical, closes the one real violation of the
   product's core promise.
2. **F3** — `.safeParse()` + full issue list. Land alongside #266's structured-receipts work
   rather than as a separate change.
3. **F5** — `dryRun` on `remember`/`capture`, reusing the existing gate/write separation.
4. **F4** — one schema-discovery MCP resource generated from `schema.ts`, not hand-written.
5. **F7** — fix the parity table. Trivial once F2 is scoped.
6. **F6** — rename `projects.ts`'s `sources` field; cross-reference the three `source`s in
   JSDoc.
7. **F2** — add MCP tools for `pending`/`reject`/`config get-set`; deliberately leave
   `promote`/`consolidate`/`graduate` gated. Largest, and the only one that needs a design
   decision (which curation ops get to be tools) rather than just an implementation.

Ranked by (impact × inverse fix cost), not by severity alone — F1 outranks F2 despite F2
affecting more surface area, because F1 is a one-call-site fix for a correctness bug and F2 is
a scoping exercise before any code gets written.
