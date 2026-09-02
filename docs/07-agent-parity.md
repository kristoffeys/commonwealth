---
title: Claude Code and Codex parity
type: reference
status: accepted
updated: 2026-09-02
tags: [claude-code, codex, mcp, hooks, diagnostics]
---

# Claude Code and Codex parity

Commonwealth uses one brain, registry, MCP server, and curation pipeline in both hosts. The plugin
payload contains a host manifest for each agent; `commonwealth init --agent claude|codex|both`
selects which integrations to install without duplicating brain data.

This page compares the two hosts that run Commonwealth's **lifecycle hooks**. A host that only
speaks MCP (Claude Desktop's Chat tab, a bare MCP client) is a different contract — see
[Hosts without our hooks](#hosts-without-our-hooks) — and neither this table nor its rows should be
read as applying to it.

| Capability | Claude Code | Codex |
| --- | --- | --- |
| One-command onboarding | `--agent claude` (default) | `--agent codex` |
| Mixed-host onboarding | `--agent both` | `--agent both` |
| MCP tools (`search`, `ask`, `read`, `remember`, `list-work-state`, `who-is`) | Shared server | Shared server |
| MCP prompts (`ask`/`recall`/`remember`/`decide`/`status`/`promote`) | Shared server | Shared server |
| Curation verbs beyond `remember` (`reject`, `pending`, `consolidate`, `graduate`, `scope`) | CLI only — no MCP tool | CLI only — no MCP tool |
| Session-wide context | `SessionStart` | `SessionStart` |
| Prompt-relevant context | `UserPromptSubmit` | `UserPromptSubmit` |
| Pre-compaction capture | `PreCompact` | `PreCompact` |
| Completed-work capture | `SessionEnd` | Throttled `Stop` turn boundary |
| Recursive extraction | `claude -p` adapter | `codex exec` adapter |
| Read-only context fallback | `CLAUDE.md`-style project config | Generated `AGENTS.md` slice |
| Git sync (commit/pull/push) | Lifecycle hooks (ADR-0032) | Lifecycle hooks (ADR-0032) |
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

## Hosts without our hooks

Claude Desktop's Chat tab, and any bare MCP client, register the Commonwealth MCP server without
installing the lifecycle hooks. The parity table above does **not** describe them. Their contract,
stated so it is not a surprise:

| | Claude Code / Codex | MCP-only host |
| --- | --- | --- |
| Automatic capture at session boundaries | Yes (`SessionEnd`/`Stop`/`PreCompact`) | **No.** Only what the agent is explicitly told to `remember` is ever written. |
| Proactive context injection | Yes (`SessionStart`, `UserPromptSubmit`) | **No.** The agent must call `search`/`ask`/`read`, or the client must read the MCP resources. |
| Writes reach teammates | Lifecycle hooks commit + push (ADR-0032) | Yes — the **server** commits and pushes on write (ADR-0040), and says whether it succeeded. |
| Inbound teammate notes | Next `SessionStart` | Server start (a pull) — not mid-conversation. |
| Contradiction guard / reclassify / receipts | Yes (hook-driven) | **No.** These hang on hook events. |

Before ADR-0040 the third row was the dangerous one: a note written through `remember` on a
hookless host was left as an untracked working-tree file that never reached anyone, while the tool
answered "remembered" (#290). The MCP server now owns sync on those hosts — `pull` at startup,
`commit` + `push` on a note landing in canon — and reports honestly when it cannot publish (no
remote, offline, no credentials, or another sync holding the lock). Our own plugin sets
`COMMONWEALTH_MCP_SYNC=off`, because on the hosts in the table above the hooks already do it.

The remaining rows are real, deliberate gaps: a hookless host does not automatically capture and
does not inject context. It is an explicit-write, explicit-read surface, and any claim of
"parity" here means the *tool and prompt surface*, never the lifecycle.

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
