# Changesets

This folder holds [Changesets](https://github.com/changesets/changesets) — one markdown file per
pending change describing the version bump + a changelog entry. Add one with `pnpm changeset`;
`pnpm changeset version` applies them (bumping every `@commonwealth/*` package together — they are
`fixed`), and the release workflow publishes on a version tag. `@commonwealth/plugin` is `ignore`d
(it is not published to npm; it is the Claude Code marketplace plugin).
