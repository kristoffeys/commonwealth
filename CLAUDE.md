# CLAUDE.md — working guide for Commonwealth

Commonwealth is a **multiplayer, git-backed, agent-readable second brain for teams**: a shared
repo of plain markdown (memory / decisions / work-state / people) that every teammate's
AI reads before acting and writes back to. Open source (Apache-2.0). Read `README.md` and
`docs/` before making design changes.

## Orientation (read these first)

- `docs/00-vision.md` — positioning, competitors, the edge, the wedge, risks.
- `docs/01-architecture.md` — git-as-substrate, the **concurrency model** (the crux), the
  auto-bridge. This is the most important doc.
- `docs/02-data-model.md` — the markdown/frontmatter schema for the four note kinds.
- `docs/03-distribution.md` — auto-provisioning into Claude Code, OSS + monetization.
- `docs/04-roadmap.md` — phased plan (M0–M5), mapped to GitHub milestones.
- `docs/adr/` — **Architecture Decision Records.** Every significant decision lives here.

## Non-negotiable design principles

1. **Git is the substrate.** Markdown files are the source of truth. Any DB/index is
   derived and disposable (rebuildable from files, gitignored). Never make a store the
   source of truth. (ADR-0003, ADR-0005)
2. **Design out concurrency, don't resolve it.** Notes are atomic, one-fact-per-file,
   with collision-proof ids → concurrent writes union-merge with zero conflicts. Derived
   files (COMMONWEALTH.md, INDEX.md) are regenerated, never hand-merged. Never silently
   overwrite. (ADR-0003)
3. **Prefer create/supersede over in-place edits.** `status` + `superseded_by`, not
   deletion. Git keeps history; superseding keeps the reasoning visible.
4. **Curation is gated, and review-*capable*.** Auto-captured knowledge always passes the
   scope + dedup + secret gates and is proposed via the `staging/` queue. Whether it then
   needs manual approval is the per-brain `autoPromote` flag (ADR-0014): **default on** →
   captured notes promote straight to canon (curation gating still runs; only the manual
   review step is skipped); set it `false` to require `/commonwealth:promote`. The queue,
   `promote`/`reject`, and PR-review path all remain.

## Stack & layout (ADR-0002)

- TypeScript (strict, ESM), Node ≥ 22, **pnpm** workspaces monorepo.
- Vitest (test), ESLint + Prettier, tsup (build).
- `packages/core` — schema, note IO, scaffold, derived index. (More packages — MCP
  server, CLI, daemon, plugin — arrive in later milestones.)
- `@cmnwlth/core` public surface is `packages/core/src/index.ts`. `schema.ts` and
  `ids.ts` are the stable contract other modules build on.

## Commands

```bash
pnpm install            # first time (native deps better-sqlite3/esbuild are allowlisted)
pnpm build              # build all packages (tsup)
pnpm typecheck          # tsc --noEmit across packages
pnpm test               # vitest run
pnpm lint               # eslint
pnpm format             # prettier --write
```

Note: `better-sqlite3` and `esbuild` are in `pnpm.onlyBuiltDependencies`. After a fresh
clone on a new platform, run `pnpm rebuild better-sqlite3 esbuild` if native modules fail.

## How we work (project management)

- **Source of truth for tasks = the GitHub Project** "Commonwealth — Build"
  (`gh project view 2 --owner kristoffeys`). Issues are grouped by milestone (M0–M5).
- **Keep the board live.** When you start an issue set its Status to _In Progress_; when
  a PR merges / work lands, set it _Done_. Reference issues in commits (`#12`).
- **Every significant decision → an ADR** in `docs/adr/` (MADR-lite), linked from its
  `type:decision` issue. ADRs are immutable once Accepted; supersede, don't edit.
- **Conventional-ish commits**, imperative mood. Small, reviewable PRs. Trunk is `main`;
  branch for feature work.
- Work autonomously; verify with tests before claiming done. If tests fail, say so.

## Definition of done (per feature)

Typechecks, lints, has tests (the concurrency-sensitive paths _must_ have tests), and the
relevant issue is moved to Done with a one-line note of what shipped.

**Keep `README.md` current.** When the feature set broadens (a new package, CLI, or
user-facing capability), update the README's Getting Started, Packages table, and Status
in the same PR so it always reflects what the tool can actually do.
