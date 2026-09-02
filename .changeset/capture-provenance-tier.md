---
"@cmnwlth/core": minor
"@cmnwlth/curate": minor
---

Record how a note entered the brain: an optional `intake` frontmatter tier (`internal` /
`external`) stamped once per capture run, surfaced in the review queue as `⇢ external intake`
(ADR-0038). Absent means `internal`, so existing notes and ordinary session captures are unchanged;
`commonwealth-curate capture --external` marks an ingestion run from a system outside the brain, and
the curator agent is told to hold rather than promote such a candidate. Prerequisite for the seed
connectors in #150; closes #274.
