# 11. Brain wiring: the global user registry is the default source of truth

- Status: Superseded by [ADR-0024](0024-rule-based-brain-resolution.md)
- Date: 2026-07-01
- Deciders: kristof (owner), Claude (orchestrator)
- Relates: [ADR-0008](0008-curation-locality.md), [ADR-0009](0009-brain-config-feature-flags.md),
  [distribution](../03-distribution.md), issue #14

## Context

A project → brain mapping decides which brain a working directory reads and writes. The
resolver (`packages/core/src/registry.ts`, `resolveBrainDir`) has always supported five layers,
in order: (1) a per-project `.commonwealth/brain` marker file, (2) a directory that is itself a
brain, (3) the global user registry `~/.commonwealth/registry.json` (a `prefix → brain` map),
(4) the `COMMONWEALTH_BRAIN_DIR` env var, (5) nothing.

Onboarding, however, wired brains by dropping the layer-1 **marker** into every synced folder.
That scatters a `.commonwealth/` directory into each project — clutter in a solo checkout, and a
marker that does not travel with the machine (it lives in the project, not the user's config).
Layer 3 already existed and is a better home for the default mapping: one global file, nothing
added to the project tree.

## Decision

1. **The global user registry is the DEFAULT brain-wiring source of truth.** Onboarding writes a
   `prefix → brain` mapping into `~/.commonwealth/registry.json` (resolver layer 3) for each
   synced folder, instead of dropping a per-project marker.
2. **The per-project `.commonwealth/brain` marker stays as an optional manual override.**
   `core.setBrainMarker` and resolver layer 1 are unchanged; a marker still resolves ahead of a
   registry mapping (layer 1 > 3) so a human can pin one project explicitly.
3. **Convenience symlinks.** Onboarding also drops `~/.commonwealth/brains/<name> → <brainDir>`
   (where `<name>` is the basename of the brain directory) so a human can `ls`/`cd` their brains.
   Symlink creation degrades gracefully — a real file/dir at the path is left intact, and
   unsupported/permission cases (Windows/EPERM/EACCES/ENOSYS) are reported, never thrown.
4. **`@cmnwlth/core` owns the writes:** `addRegistryMapping` (idempotent add/update, dedupe
   by expanded prefix), `linkBrain` (idempotent, non-clobbering symlink), plus `defaultRegistryPath`
   and `defaultBrainsDir` helpers. The CLI's `registerBrain` onboarding step composes them.
5. **No multi-brain-per-project yet.** One prefix maps to exactly one brain.
6. **Brain identity is keyed off `.commonwealth/schema-version`, not `.commonwealth/config.json`.**
   The self-is-brain layer (resolver layer 2) previously identified a brain by the presence of
   `.commonwealth/config.json`. But the per-user *scope* config (ADR-0008) lives at
   `~/.commonwealth/config.json`, so walking up from any project under `$HOME` matched the home
   directory as a brain — shadowing the registry entirely (and only latent on machines that have
   run `init`; CI has no such file, so the bug hid there). Identity now uses the brain-only
   `schema-version` scaffold artifact, which the global scope dir never has.

## Consequences

- One global file wires every project; no per-project `.commonwealth/` clutter and the mapping is
  portable within a user's machine.
- `~/.commonwealth/brains/` gives a human a browsable index of their brains.
- Two override paths remain for special cases: the marker (layer 1) and `COMMONWEALTH_BRAIN_DIR`
  (layer 4).
- Two files live under `~/.commonwealth/`: `config.json` (per-user scope allow/deny, ADR-0008) and
  `registry.json` (project → brain routing). The README's Configuration section disambiguates them.

## Alternatives considered

- **Per-project marker as the default (the prior behavior)** — rejected: it clutters every solo
  checkout with a `.commonwealth/` dir and the mapping does not live with the user's config. Kept
  only as an explicit manual override.
- **Multi-brain-per-project** — deferred; not needed yet and it complicates resolution.

Supersedes nothing.
