# Release checklist

Commonwealth releases move the CLI packages, both host manifests, the marketplace entry, and the
published plugin runtimes in lockstep. A release is not complete until a marketplace install works
without access to the monorepo checkout.

## Automated release gate

From a clean checkout:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
node scripts/release.mjs verify
```

`release.mjs verify` checks that every workspace package, the Claude and Codex manifests, and the
marketplace entry have one version. It also checks the exact `@cmnwlth/mcp` and
`@cmnwlth/curate` pins and inventories the portable plugin payload.

The hermetic standalone tests then copy that payload outside the checkout and prove:

- Both manifests and both hook configurations are present.
- Every Claude hook entry and the Codex dispatcher starts from the copied install.
- The capture worker, extraction runtime, and extraction schema load without workspace imports.
- A marketplace-shaped copy selects the published, version-pinned `npx` runtimes.
- A separately copied same-platform `vendor/` bundle starts the MCP server without resolving
  dependencies from workspace `node_modules`.

`vendor/` is deliberately not a marketplace release artifact. It includes a platform-local
`better-sqlite3` binary. Fresh marketplace installs use the portable pinned npm packages, as
recorded in [ADR-0026](adr/0026-portable-plugin-runtime-fallback.md).

## Authenticated fresh-marketplace acceptance

Run this after the target npm versions and marketplace ref are available. It is opt-in because it
uses the network, real host CLIs, and paid authenticated extraction:

```bash
COMMONWEALTH_FRESH_MARKETPLACE_SMOKE=1 \
ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
OPENAI_API_KEY="$OPENAI_API_KEY" \
COMMONWEALTH_MARKETPLACE_SOURCE=kristoffeys/commonwealth \
COMMONWEALTH_MARKETPLACE_SHA=<full-40-character-release-commit> \
node scripts/smoke-fresh-marketplace.mjs both
```

Run `claude` or `codex` instead of `both` to prove only one host. The script creates fresh
`HOME`, `CLAUDE_CONFIG_DIR`, and `CODEX_HOME` directories, installs from the configured marketplace,
requires and checks out the exact full commit SHA, gives Codex that Git source with `--ref` so its
live snapshot is owned under `CODEX_HOME`, and rejects any plugin path that points back into the
source checkout. After install it deletes the independently verified marketplace clone and
requires both host install paths to remain live. It then performs the full
acceptance path from the installed payload and matching published package version:

- Initializes and wires a new git-backed brain with the published `@cmnwlth/cli`.
- Probes the installed hook's exact pinned curate runtime.
- Starts the pinned MCP server over stdio and performs `remember → search → read` against the brain.
- Invokes each host's installed `SessionStart` entry and verifies the remembered note is injected
  as proactive context.
- Obtains a schema-valid response from each real authenticated host extractor.
- Runs each installed host lifecycle capture entry (Claude `session-end.mjs`; Codex `Stop`) through
  its detached worker with a deterministic fake extractor, proves the note was persisted through
  published curate, and consumes the successful deferred receipt through the installed host
  `SessionStart` entry. The deterministic candidate keeps the persistence assertion independent of
  model phrasing; the preceding check still exercises the real authenticated model.
- Forces the real Claude/Codex extraction adapters down their unavailable-binary path and verifies
  each produces a loud, host-specific deferred failure receipt without running curate.
- Runs the matching published sync package twice and requires the second pass to be an idempotent
  no-op.

The isolated home is deleted on success or failure; set `COMMONWEALTH_SMOKE_KEEP_HOME=1` only while
diagnosing a failure.

Record the following in the release or PR evidence:

- Release version and immutable marketplace ref/tag.
- OS, architecture, Node version, Claude Code version, and Codex version.
- `release.mjs verify` output and hermetic test result.
- Fresh-marketplace smoke result for `both`.
- Installed Claude and Codex cache paths printed by the smoke.
- MCP read/write evidence, proactive-context evidence, successful capture receipt, host-specific
  failure receipt evidence, and the repeated sync no-op result printed by the smoke.
- Confirmation that neither installed path points into the source checkout (the script enforces
  this and fails otherwise).
- Codex `/hooks` review result after install. Trust approval is intentionally manual and must not
  be bypassed in a user-facing release check.

## Publish and rollback

After the automated gate passes, publish the candidate and finish the authenticated acceptance:

1. Run the release versioning flow and review every changed version/pin.
2. Publish `@cmnwlth/*` packages before advertising the marketplace version.
3. Push the release tag and confirm the GitHub Release workflow completes.
4. Run the authenticated smoke against the immutable release ref.
5. Install/update both hosts normally and review Codex hooks with `/hooks`.

Do not announce the release as complete until the authenticated smoke and manual hook review pass.

If the fresh install fails, do not advertise that candidate or advance a stable marketplace ref.
Fix the package or payload, publish a new version, rerun the complete gate, and retain the failed
smoke evidence with the superseding release.
