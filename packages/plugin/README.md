# @cmnwlth/plugin — the Commonwealth agent plugin

The glue that connects Commonwealth to Claude Code and Codex. Both hosts share the same brain,
registry, sync daemon, and MCP server:

- **MCP server** `commonwealth` — the `@cmnwlth/mcp` server (`search / ask / read / remember /
  work-state / people`), auto-started by declaring it in the manifest (no manual MCP
  registration). `ask` returns citation-anchored context; the agent writes the cited answer
  (ADR-0020) — Commonwealth never embeds an LLM.
- **Claude Code lifecycle hooks** — `SessionStart` injects session-wide context (active
  work-state, recent decisions); `UserPromptSubmit` injects the notes relevant to *this turn's*
  prompt and, throttled, also captures long-session knowledge in the background (#194);
  `SessionEnd` extracts learnings from the transcript and stages them; `PreCompact` runs the same
  extraction before a long session compacts, so knowledge that scrolls out of context isn't lost
  if the session is abandoned (#195).
- **Codex lifecycle hooks** — the matching `SessionStart`, `UserPromptSubmit`, and `PreCompact`
  events use the same context and capture pipeline. Codex has no `SessionEnd`; its `Stop` event is
  a **turn boundary**, so Commonwealth performs throttled, best-effort capture after completed
  turns without describing that event as a session end (ADR-0028).
- **Brain registry** — resolves the current project directory → its brain repo
  (`@cmnwlth/core`'s `resolveBrainDir`, issue #14).
- **`/commonwealth` commands** — manual `remember`, `decide`, `recall`, `ask`, `promote`, `status`.
- **`@commonwealth:curator` subagent** — an in-session, advisory brain-tender: reviews the staging
  queue, recommends promotions/rejections, proposes consolidations, and flags contradictions with
  canon. Runs on the session model (no extra key), read-only by default, never auto-promotes (#198).

Everything real is done by the `@cmnwlth/*` packages; the plugin is glue. Markdown in the
brain repo stays the source of truth.

## Layout

```
.claude-plugin/plugin.json   manifest (name, mcpServers, hooks)
.codex-plugin/plugin.json    Codex manifest (shared MCP + Codex-specific lifecycle config)
hooks/hooks.json             Claude: SessionStart + UserPromptSubmit + PreCompact + SessionEnd
hooks/codex-hooks.json       Codex: SessionStart + UserPromptSubmit + PreCompact + Stop
hooks/lib.mjs                testable, dependency-injected hook core
hooks/session-start.mjs      thin stdin→lib→stdout entry (prints session-wide context)
hooks/user-prompt-submit.mjs thin entry: per-turn prompt-scoped context + throttled capture (#194)
hooks/session-end.mjs        thin stdin→lib entry (stages candidates)
hooks/pre-compact.mjs        thin stdin→worker entry (captures before compaction, #195)
hooks/codex-hook.mjs         Codex dispatcher for context + throttled capture events
commands/*.md                /commonwealth remember|decide|recall|promote|status
agents/curator.md            @commonwealth:curator advisory review/consolidation subagent
```

## Runtime (vendored when present; portable npx fallback)

The hooks first use `vendor/curate/index.js` when a same-platform bundle is present. Git
marketplace installs do not currently include that platform-local tree: it contains
`better-sqlite3`'s native binary, so committing one release runner's build would break other
operating systems/architectures. They therefore use the published package via
`npx -y @cmnwlth/curate@<version>`; `.mcp.json` similarly runs the published MCP package. See
[ADR-0026](../../docs/adr/0026-portable-plugin-runtime-fallback.md).

The fallback is deliberately visible. `commonwealth doctor` imports the installed hook's own
runtime resolver, prints the exact live path, and runs curate's brain-independent `--version`
through it. A broken npx cache is a failed diagnostic. If capture's curate child exits non-zero,
the next-session receipt reports **capture failed** with the runtime and exit code; it is never
reported as “no durable knowledge.”

The pinned version tracks the plugin's own version; bump both together on release.

> Local development: pass `overrides.curateEntry` (or run against a locally-built curate) to
> exercise the hooks without hitting the registry — that's how the tests run.

`scripts/bundle.mjs` builds the same-platform vendored runtime used by local smoke tests and
development. It is not a cross-platform distribution artifact.

## Host-neutral extraction

Lifecycle hooks hand session transcripts to one shared extraction contract; host adapters own the
unstable edges around that contract:

- The **Claude Code adapter** compacts Claude transcript JSONL and invokes `claude -p`.
- The **Codex adapter** invokes the supported non-interactive `codex exec` surface with a candidate
  output schema from a fresh empty working directory, preventing project `AGENTS.md` or config from
  influencing the recursive extractor. Codex does not promise a stable on-disk transcript format,
  so the adapter compacts recognized events but falls back to bounded raw transcript data when the
  event shape changes.
- Both produce only schema-validated `{ kind, title, body, tags? }` candidates. The downstream
  capture path — not the model — derives project provenance from the trusted session cwd and then
  applies scope, secret, deduplication, review, and promotion gates.

A successful, schema-valid `[]` means the extractor genuinely found no durable knowledge. A
missing CLI, authentication failure, timeout, non-zero exit, unreadable transcript, or malformed
output is a loud extraction failure and gets a failure receipt; it is never reported as an empty
session. Both adapters use the same hard timeout and `COMMONWEALTH_DISABLE_HOOKS` recursion guard,
so their nested agent process cannot recursively capture itself. See
[ADR-0027](../../docs/adr/0027-host-neutral-extraction-runtime.md).

## Lifecycle parity and host differences

The two plugin manifests intentionally select different hook files. Claude Code auto-loads the
standard `hooks/hooks.json`; the Codex manifest explicitly selects `hooks/codex-hooks.json` so
Codex never sees Claude's unsupported `SessionEnd` declaration. The brain registry, scope gate,
curation path, and detached capture worker remain shared.

| Commonwealth behavior | Claude Code event | Codex event | Semantics |
| --- | --- | --- | --- |
| Load session-wide context | `SessionStart` | `SessionStart` | Equivalent; startup, resume, clear, and post-compact starts are supported. |
| Load prompt-relevant context | `UserPromptSubmit` | `UserPromptSubmit` | Equivalent and synchronous; an irrelevant prompt injects nothing. |
| Preserve context before compaction | `PreCompact` | `PreCompact` | Equivalent; capture is detached so compaction is not blocked. |
| Capture completed work | `SessionEnd` | `Stop` | Different: Claude ends a session; Codex finishes one turn. Codex capture is throttled and best-effort. |

Codex's `Stop` hook is not an end-of-process signal. The Codex dispatcher skips recursive
stop-hook turns and uses host-prefixed throttle state for `Stop` and `PreCompact`, so a recent
pre-compaction capture does not immediately trigger the same turn-boundary work. The existing
`COMMONWEALTH_PROMPT_CAPTURE_MS` interval controls opportunistic/turn capture (`0` disables it).
`PreCompact` remains the safety boundary before context is discarded, and curation still
deduplicates the resulting candidates. A stop capture reviews the accumulated Codex transcript
available at that turn boundary, not only the latest turn.

Only command hooks run in Codex today. Do **not** add `"async": true`: Codex parses that option but
skips asynchronous handlers. Commonwealth gets non-blocking behavior by having the short command
hook launch its capture worker as a detached child. Hook stdout is reserved for the documented
context payload; diagnostics go to stderr, and hook entries exit successfully so an unavailable
brain or extractor never blocks the host.

## Install (git plugin marketplace)

The repo root ships `.claude-plugin/marketplace.json` declaring this plugin, so the repo IS a
plugin marketplace. Add it and install (user scope / global — ADR-0012):

```bash
claude plugin marketplace add kristoffeys/commonwealth
claude plugin install commonwealth@commonwealth

codex plugin marketplace add kristoffeys/commonwealth
codex plugin add commonwealth@commonwealth
```

(Or point the marketplace at a local path / your fork / an internal mirror of this repo.)

The plugin installs globally, so the `commonwealth` MCP server works in **every** selected host
session. Both hosts also load their lifecycle hooks. Per-repo routing is dynamic: the SessionStart
hook resolves the real session cwd → its
brain via the registry, and the MCP server resolves its brain via `@cmnwlth/core`'s
`resolveBrainDir` — no brain is pinned into the registration. This replaced the old raw
local-scope `claude mcp add`, which was invisible outside its install dir and pinned one brain.

Codex command hooks require an explicit trust review. After installing or updating the plugin,
open Codex, run `/hooks`, review the Commonwealth definitions, and trust their current hash. Codex
skips unreviewed plugin hooks; it asks again when an update changes their definitions. Do not work
around this product trust boundary in normal use. Automated smoke tests that already vet the
plugin may use Codex's one-run hook-trust bypass.

## Auto-provisioning via team-managed settings (issue #13)

To push the plugin to every teammate automatically, add it to your org's **managed
settings** (`managed-settings.json`, highest precedence). Register this repo as a
marketplace and force-install the plugin:

```json
{
  "extraKnownMarketplaces": {
    "commonwealth": {
      "source": {
        "source": "github",
        "repo": "kristoffeys/commonwealth"
      }
    }
  },
  "enabledPlugins": {
    "commonwealth@commonwealth": true
  }
}
```

When a teammate's Claude Code reads managed policy, the plugin is present with no manual
install — the "(semi-)automatic add to each user's setup." _Semi-_ because first run still
needs the user authenticated to the brain's git remote (their own GitHub identity); we never
hold org-wide write creds.

## Pointing the plugin at a brain

The hooks and MCP server resolve the brain for the current directory in this order (see
`@cmnwlth/core`'s `resolveBrainDir`, issue #14):

1. **`.commonwealth/brain` marker file** in the project (a path to the brain), walking up.
2. **Self-is-brain** — a directory that has `.commonwealth/config.json` is its own brain.
3. **User registry** `~/.commonwealth/registry.json` — `{ "mappings": [{ "prefix": "~/work",
"brain": "~/brains/acme" }] }`; the first prefix the cwd is under wins.
4. **`COMMONWEALTH_BRAIN_DIR`** environment variable.
5. Otherwise nothing resolves and the hooks do nothing.

Test/override env vars: `COMMONWEALTH_REGISTRY` (registry file path) and `COMMONWEALTH_CONFIG` (its
sibling `registry.json` is also consulted).

## The scope gate (ADR-0008) and autoAdr (ADR-0009)

- Every session is filtered by the **per-user scope** config (`~/.commonwealth/config.json`,
  allow/deny). Out-of-scope directories (personal projects) do **nothing**: no context is
  injected, no transcript is sent to either host's recursive extractor, and no learnings are
  captured. The same gate is applied to Claude session-end capture, Codex turn capture, and both
  hosts' pre-compaction capture. Manage it with `commonwealth-curate scope
allow|deny|show|check`.
- **Decisions** are only ever staged when the team enables the `autoAdr` feature flag
  (`commonwealth-curate feature enable autoAdr`), enforced by curate — the plugin doesn't
  bypass it.

## Manual live smoke test

Real host hook firing needs a live smoke test, so verify end-to-end by hand:

1. **Ensure the runtime is reachable:** the plugin uses the published `@cmnwlth/mcp` /
   `@cmnwlth/curate` via `npx` (a first run fetches them). For local changes, publish a dev
   version or point the hooks at a locally-built curate via `overrides.curateEntry`.
2. **Create a brain** and put a note in it:
   ```bash
   node packages/curate/dist/index.js --help   # sanity: CLI runs
   mkdir -p /tmp/acme-brain && cd /tmp/acme-brain
   node <repo>/packages/core/dist/... # or: commonwealth init (scaffold) then stage+approve a memory
   ```
3. **Register the brain** so it resolves: either drop a `.commonwealth/brain` marker in your
   project, add a `~/.commonwealth/registry.json` mapping, or `export COMMONWEALTH_BRAIN_DIR=/tmp/acme-brain`.
4. **Install the plugin** in Claude Code, Codex, or both using the commands above. For Codex, open
   `/hooks`, review Commonwealth, and trust the current hook definitions. Then open the selected
   host in an **in-scope** project directory.
5. **SessionStart:** confirm the "Relevant from the team brain" block appears in context.
   In an **out-of-scope** dir (add it via `commonwealth-curate scope deny <dir>`), confirm
   nothing is injected.
6. **`/commonwealth` commands:** run `/commonwealth status` (pending + sync), `/commonwealth remember
<fact>` (stages a note), `/commonwealth promote` (approve it), `/commonwealth recall <query>`.
7. **Capture:** in Claude Code, end the session and confirm `SessionEnd` stages candidates. In
   Codex, complete a turn and confirm the throttled `Stop` capture stages candidates; remember that
   this is a turn boundary, not `SessionEnd`. Run a manual compaction in either host to exercise
   `PreCompact`. Check `/commonwealth status` for pending notes or the next-start receipt.
8. **Privacy check:** deny a test directory in the per-user scope config and confirm neither host
   injects context or launches transcript extraction there.

Hook errors always go to **stderr** and exit 0 — a hook must never break the session.
