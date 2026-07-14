# 27. Put session extraction behind a host-neutral runtime

- Status: Accepted
- Date: 2026-07-14
- Deciders: kristof (owner); Codex
- Relates: [ADR-0007](0007-curation-review-gate.md),
  [ADR-0015](0015-note-project-provenance.md),
  [ADR-0026](0026-portable-plugin-runtime-fallback.md), #227

## Context

Commonwealth's capture pipeline originally read Claude Code transcript JSONL and invoked
`claude -p` directly. Brain resolution, scope, curation, storage, and sync were already independent
of the agent host, but this extraction step prevented Codex sessions from using the same path.

Codex provides a supported non-interactive surface in `codex exec`, including schema-constrained
output. Its hook `transcript_path` is useful input, but Codex explicitly does not treat the
transcript's on-disk format as a stable interface. Treating today's event shape as a permanent API
would replace one host coupling with another. Conversely, interpreting a changed transcript as an
empty session would silently lose knowledge.

The extractor is also a recursive agent invocation. It must not fire Commonwealth hooks inside
itself, and it must not be allowed to hang a lifecycle worker indefinitely.

## Decision

Put extraction behind an explicit host boundary. Capture orchestration accepts a normalized
extraction request and selects a host adapter; it does not know either host's CLI arguments or
transcript event schema.

1. **One request and result contract.** A request carries the host, trusted session metadata, and a
   bounded transcript payload represented as untrusted data. A successful result is an array of
   candidate notes limited to `kind`, `title`, `body`, and optional `tags`. The shared validator
   enforces the candidate schema and four supported kinds before curation sees the result.
2. **Thin host adapters.** The Claude Code adapter preserves the current compaction and `claude -p`
   behavior. The Codex adapter invokes the supported non-interactive `codex exec` surface and uses
   an output schema. Neither adapter can invoke the other host's CLI. Codex runs from a fresh empty
   working directory because `--ignore-user-config` does not suppress project `AGENTS.md`
   discovery; repository-authored instructions remain transcript data, not extractor instructions.
3. **Normalize, then fall back safely.** Each adapter translates recognized transcript events to a
   compact role/text/tool-summary form. For Codex, recognized event decoding is best-effort because
   the transcript format may change. If no known records can be decoded, the adapter sends a
   bounded raw transcript instead of pretending the session was empty. In both forms, the
   extraction system prompt treats the transcript as data and never follows instructions from it.
4. **Empty is a value; failure is a state.** A zero-candidate result is valid only when the host
   process exits successfully and returns schema-valid `[]`. A missing CLI, authentication error,
   timeout, non-zero exit, unreadable transcript, or malformed/schema-invalid output is an
   extraction failure. Failures produce a loud deferred receipt and never reuse the
   “no durable knowledge” receipt.
5. **Bound and isolate recursive work.** Both adapters inherit the existing hard timeout and
   process termination behavior. They set Commonwealth's recursion-guard environment variable;
   hook entry points and detached workers exit early when it is present. Transcript compaction and
   a final byte cap bound model input without dropping early decisions during normal sessions.
6. **Keep provenance downstream.** The model proposes note content; it does not assign ids,
   project source, author, timestamps, or storage paths. The trusted capture/curation boundary
   derives project provenance from the resolved session cwd and applies the existing validation,
   secret, deduplication, scope, review, and promotion gates. Host/session metadata may appear in
   diagnostics, but is not accepted as model-authored note provenance.

## Consequences

- Claude Code keeps its existing extraction behavior and receipts while Codex can use the same
  candidate and curation contract without shelling out to `claude`.
- New hosts require a normalizer and extractor adapter, not a fork of the brain pipeline.
- A Codex transcript format change may reduce compaction quality and increase bounded model input,
  but it cannot silently become a successful empty extraction.
- Authentication and CLI availability remain host-local operational dependencies. Their failures
  are visible to the user rather than being confused with a session that contained no durable
  knowledge.
- Running Codex outside the captured repository prevents project instructions and project config
  from influencing the recursive extractor. The trusted session cwd remains available to
  downstream provenance logic, not to the model runtime.
- Strict candidate validation narrows what an extractor may write. Trusted capture code remains
  the only authority for provenance and storage metadata.

## Alternatives considered

- **Keep the Claude extractor and invoke it for Codex sessions.** Rejected: it requires an
  unrelated CLI/account and makes Codex capture depend on Claude Code.
- **Parse both transcript formats in capture orchestration.** Rejected: host-specific schemas and
  command behavior would continue leaking into the shared pipeline.
- **Depend on Codex's current transcript JSONL shape.** Rejected: `transcript_path` is supported,
  but its file format is explicitly unstable. Known-shape normalization plus a bounded raw
  fallback fails more safely.
- **Treat any empty or malformed stdout as zero candidates.** Rejected: that recreates the silent
  capture-loss failure fixed by ADR-0026.
- **Let the model emit source and other provenance fields.** Rejected: provenance must come from
  trusted session routing, not generated content.
