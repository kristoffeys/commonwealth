---
"@cmnwlth/curate": minor
---

Reclassify decision-shaped memory notes into decisions (#265): a new pass promotes team decisions that were filed as `memory` — the pattern in brains seeded from git history, where every commit maps to `memory`, or in brains that ran with `autoAdr` off — into real `decision` notes. `@cmnwlth/curate` gains `planReclassify`/`applyReclassify`/`reclassify` (the deterministic engine, with the kind judgment injected per ADR-0030) plus a `curate reclassify --emit/--apply` CLI surface; the plugin adds the fail-closed host-model judge (`hooks/reclassify.mjs`) and the `/commonwealth:reclassify` slash command. Each qualifying memory note yields one `decision` that SUPERSEDES its source (create/supersede — never deletes), reusing the existing secret/autoAdr/dedup gate and auto-promotion. Consolidating near-duplicate decisions is left to `consolidateCanon` (ADR-0017).
