# Contributing to Commonwealth

Thanks for your interest! Commonwealth is a multiplayer, git-backed, agent-readable second brain
for teams — plain markdown as the source of truth, everything else derived. This guide covers how
to build it and how changes land.

## Getting set up

Requirements: **Node ≥ 22**, **pnpm 10+**, **git**.

```bash
git clone https://github.com/kristoffeys/commonwealth.git
cd commonwealth
pnpm install          # native deps (better-sqlite3/esbuild) are allowlisted for build
pnpm build            # build every package (tsup)
```

If native modules fail after a fresh clone on a new platform: `pnpm rebuild better-sqlite3 esbuild`.

## The loop

```bash
pnpm typecheck        # tsc --noEmit across packages
pnpm test             # vitest run
pnpm lint             # eslint
pnpm format           # prettier --write   (CI checks format:check)
```

CI runs typecheck + test on Node 22 and 24, and lint + format on one version. All four must be
green. See `CLAUDE.md` for the deeper working guide and `docs/` for architecture.

## Definition of done (per change)

- Typechecks, lints, formatted, and **has tests** — concurrency- and security-sensitive paths
  (sync, the secret gates, note IO) _must_ have tests.
- **Keep `README.md` current** when a user-facing capability changes.
- Small, reviewable PRs; imperative, conventional-ish commit messages; trunk is `main`, branch
  for feature work.

## Design principles (non-negotiable)

1. **Git is the substrate.** Markdown files are the source of truth; any DB/index is derived and
   disposable (rebuildable, gitignored). Never make a store the source of truth.
2. **Design out concurrency, don't resolve it.** Atomic, one-fact-per-file notes with
   collision-proof ids union-merge with zero conflicts; derived files are regenerated, never
   hand-merged; never silently overwrite.
3. **Prefer create/supersede over in-place edits** (`status` + `superseded_by`, not deletion).
4. **Curation is gated.** Captured knowledge passes the scope + dedup + secret gates.

## Architecture Decision Records

Every significant decision gets an ADR in [`docs/adr/`](docs/adr/) (MADR-lite). **ADRs are
immutable once Accepted — supersede, don't edit.** If your change alters a decision, add a new ADR
that supersedes the old one and link it.

## Security

Please report vulnerabilities privately — see [`SECURITY.md`](SECURITY.md), not a public issue.

## License

By contributing, you agree your contributions are licensed under the project's
[Apache-2.0](LICENSE) license.
