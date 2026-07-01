# 9. Brain-level config & feature flags (incl. optional auto-ADR)

- Status: Accepted
- Date: 2026-07-01
- Deciders: kristof (owner), Claude (orchestrator)
- Relates: [ADR-0008](0008-curation-locality.md), [data-model](../02-data-model.md), issues #32, #33

## Context

Some settings belong to the whole team and should travel with the brain (feature toggles,
name, remotes) — as opposed to the per-user, per-machine scope config (`~/.commonwealth/…`,
ADR-0008) which must stay local. The brain already has a `.commonwealth/config.json` stub; it
should become the typed home for shared/global settings. First requested feature: an
optional **auto-ADR** — when a decision is made in a project, record it as an ADR that
lives in the brain.

## Decision

1. **Two config layers, kept distinct** (documented in the README):
   - **Per-user, local, unsynced** — `~/.commonwealth/config.json`: scope allow/deny (ADR-0008).
   - **Brain-level, shared, synced** — `<brain>/.commonwealth/config.json`: `name`, `remotes`,
     `curation`, and a typed `features: Record<string, boolean>` map. Because it's in the
     repo, feature settings apply to the whole team.
2. **`@commonwealth/core` owns brain config**: `loadBrainConfig` (never throws; fills defaults),
   `saveBrainConfig`, `setFeature`, `isFeatureEnabled` (unknown/unset ⇒ `false`), and a
   `FEATURE_FLAGS` registry (name + description + default). Scaffold writes the `features`
   block with all flags defaulted **off**.
3. **auto-ADR maps onto the existing `decision` note kind** (ADR-style, in `decisions/`),
   so ADRs live in the brain by construction — no new kind. The flag is `autoAdr`,
   **default off**.
4. **Enforcement is in curation**: `curate()` drops `decision`-kind candidates with reason
   `"auto-adr-disabled"` unless `isFeatureEnabled(brain, "autoAdr")`. So even if a capture
   agent proposes a decision, it is only staged when the team has opted in. Decisions still
   pass through the staging review queue (ADR-0007) before becoming canon, and respect the
   per-user scope filter (ADR-0008).
5. **Extraction** (turning a session into decision candidates) is the M4b SessionEnd
   capture agent's job; when `autoAdr` is on it is prompted to extract decisions
   (context / choice / rejected options / consequences).

## Consequences

- One clear, synced place for team-wide toggles; trivial to add future flags.
- auto-ADR reuses existing machinery (decision kind + review queue + scope) — small,
  testable surface now; the agentic extraction lands with the M4b hook.
- Two files named `config.json` in different roots (`~/.commonwealth` vs `<brain>/.commonwealth`);
  the README's Configuration section disambiguates them.

## Alternatives considered

- **A dedicated `adr/` folder / new note kind** — rejected; the `decision` kind already is
  an ADR and lives in the brain.
- **Auto-ADR always on** — rejected; noisy and opinionated. Opt-in per team via the flag.
