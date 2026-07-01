# @commonwealth/plugin — the Commonwealth Claude Code plugin

The glue that makes Commonwealth "just happen" inside Claude Code. It bundles everything a
teammate needs and wires the auto-bridge (docs/03-distribution.md):

- **MCP server** `commonwealth-brain` — the `@commonwealth/mcp` server (`search / read / remember /
work-state / people`), auto-started by declaring it in the manifest (no manual
  `claude mcp add`).
- **Lifecycle hooks** — `SessionStart` pulls relevant team-brain context and injects it;
  `SessionEnd` extracts learnings from the transcript and stages them into the review queue.
- **Brain registry** — resolves the current project directory → its brain repo
  (`@commonwealth/core`'s `resolveBrainDir`, issue #14).
- **`/commonwealth` commands** — manual `remember`, `recall`, `promote`, `status`.

Everything real is done by the `@commonwealth/*` packages; the plugin is glue. Markdown in the
brain repo stays the source of truth.

## Layout

```
.claude-plugin/plugin.json   manifest (name, mcpServers, hooks)
hooks/hooks.json             SessionStart + SessionEnd → node <script>.mjs
hooks/lib.mjs                testable, dependency-injected hook core
hooks/session-start.mjs      thin stdin→lib→stdout entry (prints context)
hooks/session-end.mjs        thin stdin→lib entry (stages candidates)
commands/*.md                /commonwealth remember|recall|promote|status
scripts/bundle.mjs           vendor built mcp/curate/sync + deps → vendor/
vendor/<pkg>/…               (generated) standalone runtime the hooks/MCP call
```

## Build the vendored runtime

The plugin runs standalone with `node` — no pnpm workspace on the user's machine — so its
runtime is vendored:

```bash
pnpm --filter @commonwealth/plugin bundle
```

This runs `pnpm -r build` then copies `packages/{mcp,curate,sync}/dist` plus their required
`node_modules` into `packages/plugin/vendor/<pkg>/`. **The bundle is platform-local**:
`better-sqlite3` ships a prebuilt native binary for the OS/arch it was built on. A
cross-platform build / npm publish with per-platform prebuilds is a later task.

## Install (git plugin marketplace)

```
/plugin marketplace add kristoffeys/Commonwealth
/plugin install commonwealth
```

(Or point the marketplace at your fork / internal mirror of this repo.)

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
        "repo": "kristoffeys/Commonwealth"
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
`@commonwealth/core`'s `resolveBrainDir`, issue #14):

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
  injected and no learnings are captured. Manage it with `commonwealth-curate scope
allow|deny|show|check`.
- **Decisions** are only ever staged when the team enables the `autoAdr` feature flag
  (`commonwealth-curate feature enable autoAdr`), enforced by curate — the plugin doesn't
  bypass it.

## Manual live smoke test

Real Claude Code hook firing can't be exercised by the unit tests, so verify end-to-end by
hand:

1. **Build the vendor bundle:** `pnpm --filter @commonwealth/plugin bundle`.
2. **Create a brain** and put a note in it:
   ```bash
   node packages/curate/dist/index.js --help   # sanity: CLI runs
   mkdir -p /tmp/acme-brain && cd /tmp/acme-brain
   node <repo>/packages/core/dist/... # or: commonwealth init (scaffold) then stage+approve a memory
   ```
3. **Register the brain** so it resolves: either drop a `.commonwealth/brain` marker in your
   project, add a `~/.commonwealth/registry.json` mapping, or `export COMMONWEALTH_BRAIN_DIR=/tmp/acme-brain`.
4. **Install the plugin** (`/plugin marketplace add <this repo>` → `/plugin install
commonwealth`) and open Claude Code in an **in-scope** project directory.
5. **SessionStart:** confirm the "Relevant from the team brain" block appears in context.
   In an **out-of-scope** dir (add it via `commonwealth-curate scope deny <dir>`), confirm
   nothing is injected.
6. **`/commonwealth` commands:** run `/commonwealth status` (pending + sync), `/commonwealth remember
<fact>` (stages a note), `/commonwealth promote` (approve it), `/commonwealth recall <query>`.
7. **SessionEnd:** end the session; if `claude` is on PATH the SessionEnd hook extracts
   candidates and stages them — check `/commonwealth status` shows new pending notes. If `claude`
   is unavailable, the hook logs to stderr and stages nothing (never breaks the session).

Hook errors always go to **stderr** and exit 0 — a hook must never break the session.
