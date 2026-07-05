# 18. Package consolidation — keep six packages (for now), with a bundling path documented

- Status: Accepted
- Date: 2026-07-05
- Deciders: kristof (owner), Claude (orchestrator)
- Relates: [ADR-0002](0002-implementation-stack.md), [ADR-0012](0012-mcp-distribution-via-plugin.md),
  issues #131 (spike), #49 (npm publish), #62 (plugin runtime)

## Context

We publish six packages: four "libraries" (`core`, `curate`, `sync`, `seed`) and two "apps"
(`cli`, `mcp`). The CLI is a ~38 KB dispatcher: it **imports** `core`+`seed` and **spawns** the
`curate`+`sync` **binaries** as subprocesses; `mcp` imports `core`+`curate`. So all six are needed
at runtime today. Question (#131): should we **bundle** the libraries into just `cli` + `mcp` and
publish two packages instead of six?

## Findings (proof-of-concept)

- **Bundling is feasible.** A throwaway `tsup` build of `mcp` with `noExternal: [/@cmnwlth\//]`
  and `external: ["better-sqlite3"]` produced a single 929 KB file with **all `@cmnwlth/*`
  inlined** (0 residual refs) and the native `better-sqlite3` kept external. So a collapsed
  package would declare exactly one runtime dependency (`better-sqlite3`), which npm installs as a
  per-platform prebuild — the same model the published packages already use.
- **`better-sqlite3` must stay external** regardless (a native `.node` can't be bundled); it is a
  declared dep so `npm install` fetches the right binary. (A bundle run outside a tree that has
  `better-sqlite3` resolvable fails — a packaging concern, not a bundling one.)
- **The real cost is the CLI's process model, not bundling:**
  - `cli` delegates via `delegateCurate`/`delegateSync`, which resolve and **spawn the
    `commonwealth-curate` / `commonwealth-sync` bins**. Collapsing removes those packages/bins, so
    the CLI must instead re-invoke its **own** bundled binary with internal subcommands (or call
    the functions in-process).
  - `commonwealth sync start` **detaches a long-lived daemon** — that still needs a process entry
    (e.g. a hidden `__sync-daemon` self-invocation).
  - The **plugin hooks run `npx @cmnwlth/curate`** (scope/context/capture) and `.mcp.json` runs
    `npx @cmnwlth/mcp` (#62). If `curate` stops being published, the hooks must route those three
    operations through `@cmnwlth/cli` subcommands — and `capture`/`scope check`/`context` aren't
    all first-class CLI verbs today, so new (possibly hidden) verbs are needed.

## Decision

**Keep the six packages for now.** Do **not** collapse yet. Rationale:

- They just shipped at 0.1.0 and work; Changesets `fixed` already versions all `@cmnwlth/*`
  together in one step, so the "six versions" cost is mostly nominal.
- The collapse's benefit (fewer published packages, one fewer plugin version-pin) is largely
  cosmetic post-launch, while the cost is **non-trivial, risky rewiring** of the CLI's subprocess
  delegation + the detached daemon + the plugin's hook→curate path.
- Keeping `core`/`curate`/etc. as real packages preserves the option of `core` (schema + note IO)
  being an importable library for integrations — consistent with the "infrastructure" positioning
  — even though nothing external imports it today.

## When to revisit (triggers)

- Release/versioning friction across six packages becomes painful in practice.
- The plugin's version-pin coupling (`npx @cmnwlth/{mcp,curate}@<v>`) causes drift/bugs.
- We decide `core` will **not** be a public library — then publishing four libraries no one imports
  is pure overhead and collapsing to `cli` + `mcp` is the right cleanup.

## Migration sketch (if/when we collapse)

1. `cli` + `mcp` each add `noExternal: [/@cmnwlth\//]`, keep `better-sqlite3` external, and declare
   it as their sole runtime dep. Mark `core`/`curate`/`sync`/`seed` `private` (unpublished).
2. Replace `delegateCurate`/`delegateSync` with either in-process calls or hidden self-subcommands
   (`commonwealth __curate …`, `commonwealth __sync …`); route the detached daemon through a
   `__sync-daemon` self-invocation.
3. Add the CLI subcommands the plugin hooks need (`scope check`, `context`, `capture`) and point
   the hooks/`.mcp.json` at `@cmnwlth/cli` (or a still-published slim `mcp`).
4. Verify: `npx @cmnwlth/cli init`, the plugin end-to-end, and `better-sqlite3` resolving from a
   clean install on Linux + macOS.

No behavior changes ship from this ADR; it records the decision and keeps collapse a ready,
scoped option.
