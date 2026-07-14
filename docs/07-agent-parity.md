---
title: Claude Code and Codex parity
type: reference
status: accepted
updated: 2026-07-14
tags: [claude-code, codex, mcp, hooks, diagnostics]
---

# Claude Code and Codex parity

Commonwealth uses one brain, registry, MCP server, curation pipeline, and sync daemon in both
hosts. The plugin payload contains a host manifest for each agent; `commonwealth init --agent
claude|codex|both` selects which integrations to install without duplicating brain data.

| Capability | Claude Code | Codex |
| --- | --- | --- |
| One-command onboarding | `--agent claude` (default) | `--agent codex` |
| Mixed-host onboarding | `--agent both` | `--agent both` |
| MCP search/read/write/curate | Shared server | Shared server |
| Session-wide context | `SessionStart` | `SessionStart` |
| Prompt-relevant context | `UserPromptSubmit` | `UserPromptSubmit` |
| Pre-compaction capture | `PreCompact` | `PreCompact` |
| Completed-work capture | `SessionEnd` | Throttled `Stop` turn boundary |
| Recursive extraction | `claude -p` adapter | `codex exec` adapter |
| Read-only context fallback | `CLAUDE.md`-style project config | Generated `AGENTS.md` slice |
| Health/update | Host-specific `doctor`; `update --agent` | Host-specific `doctor`; `update --agent` |

## The intentional lifecycle difference

Codex does not expose `SessionEnd`. Its `Stop` hook means one agent turn completed; it does not
mean the thread or process ended. Commonwealth therefore performs a throttled, best-effort review
of the accumulated Codex transcript available at that turn boundary. `PreCompact` remains an
unconditional safety boundary before context is discarded. Receipts and documentation never call
Codex `Stop` a session end.

`COMMONWEALTH_PROMPT_CAPTURE_MS` controls the Stop throttle (15 minutes by default; `0` disables
ordinary turn capture). Lower values reduce the uncaptured window at the cost of more extraction
calls. Curation still deduplicates candidates before they reach canon or review.

## Trust and privacy

Both hosts use the same per-user allow/deny scope before context retrieval or transcript
extraction. A denied project injects nothing and its transcript is not sent to either recursive
extractor. The extraction subprocess also disables Commonwealth hooks to prevent recursion.

Codex requires a human trust review for installed plugin hooks. After install or update, run
`/hooks`, inspect Commonwealth, and trust the current definition hash. Hook changes require a new
review. The CLI can diagnose installed files and runtimes, but cannot honestly claim that this
interactive trust decision has been made; it reports the `/hooks` action instead.

## Diagnose and update

Run `commonwealth doctor --json` for stable, host-prefixed health checks or plain
`commonwealth doctor` for fixes. It reports each installed host independently: plugin path, MCP
registration, hook assets, extractor/runtime path, and emitted Codex context where applicable.
Diagnostics only retain safe identity/status fields from host output; they do not print MCP
transport environment values.

Refresh one or both integrations without disturbing the other:

```bash
commonwealth update --agent claude
commonwealth update --agent codex
commonwealth update --agent both
```

All selected host updates are attempted even if the CLI self-update or one host fails. Claude Code
uses its plugin update command. Codex upgrades the installed marketplace when possible and then
re-adds the plugin idempotently; Commonwealth never removes and re-adds it, because that could
disturb enabled or trust state. After any Codex hook update, review `/hooks` again.

## Release proof

Hermetic tests copy only the marketplace payload into a temporary location and validate both
manifests, MCP configuration, lifecycle files, extraction schema, worker, and vendored runtime
without resolving files from the monorepo checkout. The [release checklist](release-checklist.md)
adds an authenticated,
environment-gated smoke for literal host execution: MCP read/write, proactive context, capture,
sync, and visible extractor-failure receipts in Claude Code and Codex.
