# 28. Map Codex lifecycle capture to an explicit turn boundary

- Status: Accepted
- Date: 2026-07-14
- Deciders: kristof (owner); Codex
- Relates: [ADR-0008](0008-curation-locality.md),
  [ADR-0012](0012-mcp-distribution-via-plugin.md),
  [ADR-0027](0027-host-neutral-extraction-runtime.md), #225

## Context

Commonwealth's Claude Code plugin loads context at `SessionStart` and `UserPromptSubmit`, captures
before `PreCompact`, and performs a final extraction at `SessionEnd`. Codex exposes the first three
events with compatible command-hook input and context output, but it does not expose
`SessionEnd`. Its closest event is `Stop`, which runs whenever an agent turn finishes. Calling that
event a session end would promise a lifecycle guarantee Codex does not provide.

The hosts also need distinct lifecycle declarations. Codex loads `hooks/hooks.json` by default,
but that file must retain Claude's `SessionEnd` event. Codex lets its manifest select another hook
file. Codex command hooks require users to review and trust their exact definitions, and its
parsed `async` handler option is not executable.

## Decision

1. **Keep host manifests explicit.** Claude Code continues to auto-load `hooks/hooks.json`. The
   Codex manifest selects `hooks/codex-hooks.json`, which declares only `SessionStart`,
   `UserPromptSubmit`, `PreCompact`, and `Stop`. Both files call the same host-neutral hook core,
   brain resolver, scope gate, curator, and MCP server. Each Codex command also declares a Windows
   override using `%PLUGIN_ROOT%` so plugin-root resolution is portable across host shells.
2. **Treat `Stop` as a turn boundary.** Codex capture runs after a completed turn and is named and
   documented as turn capture. It is not evidence that the thread, process, or user work session
   ended. The extractor reviews the accumulated thread transcript available at that boundary, not
   only the latest turn.
3. **Throttle capture at the host boundary.** The Codex dispatcher uses host-prefixed session
   state for `Stop` and `PreCompact`. Recursive stop-hook turns are skipped, and a recent
   pre-compaction capture suppresses immediate duplicate turn capture. Curation remains the final
   content-level deduplication gate.
4. **Preserve compaction as a hard boundary.** `PreCompact` launches capture before context is
   discarded even when ordinary turn capture is throttled.
5. **Use detached command workers, not async handlers.** `hooks/codex-hook.mjs` parses stdin,
   dispatches context events, and launches the existing detached capture worker when capture is
   due. No Codex hook sets `async: true`, because Codex currently skips those handlers.
6. **Preserve the privacy boundary.** Brain resolution and the per-user allow/deny scope gate run
   before context retrieval or extraction in either host. A denied directory injects nothing and
   its transcript is never sent to the recursive extractor.
7. **Respect Codex hook trust.** Installation and update instructions require the user to review
   Commonwealth in `/hooks` and trust the current definition hash. Normal setup never bypasses
   that host security control.
8. **Fail visibly without blocking.** Hook diagnostics go to stderr and command entries exit
   successfully. A dispatcher or worker-launch failure is logged immediately; failures inside the
   detached extraction/capture pipeline are preserved as deferred receipts on the next session
   start. Neither path is reported as a successful empty capture.

## Consequences

- Codex receives the same proactive context and pre-compaction protection as Claude Code, while
  automatic capture follows the strongest lifecycle event Codex actually exposes.
- A throttled Codex turn capture is best-effort rather than a final session flush. The last short
  turn can fall inside the throttle interval; reducing the interval trades additional extraction
  cost for a smaller capture window.
- Installing both integrations does not make either host load the other's event declarations.
- Plugin hook changes require renewed Codex trust review. Until reviewed, MCP tools still work but
  proactive context and capture hooks are skipped.
- New Codex hook capabilities can be added to its dedicated file without weakening Claude Code's
  lifecycle guarantees or pretending the two event models are identical.

## Alternatives considered

- **Declare Claude `SessionEnd` in the Codex hook file.** Rejected: Codex does not support that
  event, so it would not provide capture and could invalidate or disable the hook configuration.
- **Rename Codex `Stop` to session end in Commonwealth.** Rejected: `Stop` is turn-scoped and may
  run many times in one session.
- **Capture on every Codex prompt and every Stop.** Rejected: it doubles extraction at each turn
  and increases cost without improving curation semantics.
- **Use `async: true` for capture.** Rejected: Codex parses but skips asynchronous command hooks.
- **Rely on curate deduplication alone.** Rejected: it prevents duplicate notes but still pays for
  duplicate transcript extraction at adjacent lifecycle boundaries.
