# 26. Keep the portable npx plugin runtime fallback, but make it observable and fail loud

- Status: Accepted
- Date: 2026-07-14
- Deciders: kristof (owner); Codex
- Relates: [ADR-0012](0012-mcp-distribution-via-plugin.md) (plugin distribution), #222

## Context

The git marketplace copies `packages/plugin` but does not run `npm install`. The repository's
`bundle.mjs` can create `vendor/`, but that closure contains `better-sqlite3`'s native binary for
the machine that built it. Committing or attaching one Linux-built tree would make the plugin
non-portable and break macOS/other-architecture installs.

Without `vendor/`, hooks resolve curate through `npx -y @cmnwlth/curate@<pin>`. A corrupted npx
cache caused every curate child to exit 254 with empty stdout. Capture parsed that empty stdout as
zero notes and emitted the false “no durable knowledge” receipt, hiding total capture loss.

## Decision

Keep npx as the portable marketplace fallback until Commonwealth has either a pure-JavaScript
index path or per-platform plugin artifacts. Do not commit the current platform-local vendor tree.

Make the fallback observable and safe:

1. Curate exposes a brain-independent `--version` health contract.
2. The plugin exports one runtime resolver and probe. Hooks and `commonwealth doctor` use that same
   resolver, so the diagnostic cannot drift from the command capture actually runs.
3. `doctor` names the live path. A healthy vendored path passes; a healthy npx fallback warns that
   npm registry/cache remain in the critical path; a non-zero probe fails and says capture is off.
4. A non-zero capture child result is a capture failure, never `{ captured: 0 }`. The deferred
   receipt names the runtime and exit code, says extracted knowledge was not saved, and points to
   `commonwealth doctor`.

## Consequences

- Fresh git-marketplace installs remain cross-platform and still require npm/npx availability.
- Cache or registry failures are visible in both the next-session receipt and an on-demand doctor
  report; they can no longer masquerade as an uneventful session.
- Per-turn query latency still pays npx resolution on non-vendored installs. A future portable
  artifact decision should supersede this ADR and remove that dependency.
- The local bundle remains useful for smoke tests and same-platform development, but is not a
  distributable artifact.

## Alternatives considered

- **Commit `vendor/` generated on release.** Rejected: `better-sqlite3` makes it platform-local.
- **Publish the current bundle as one release artifact.** Rejected for the same portability reason;
  the marketplace also installs from the git source path, not that artifact.
- **Remove the fallback immediately.** Rejected: every fresh marketplace install would fail until
  a portable vendor format exists.
