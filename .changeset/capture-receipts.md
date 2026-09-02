---
"@cmnwlth/core": minor
"@cmnwlth/curate": minor
"@cmnwlth/cli": minor
---

Give every dropped capture candidate a structured, persisted receipt (ADR-0039, #266). A curation
veto now carries a stable category (`autoadr-vetoed`, `secret-detected`, `duplicate-lexical`,
`trivia`, …), whether the user can recover it, a plain-language cause, and a concrete next action —
persisted to the brain's derived, gitignored `index/receipts.jsonl` so it outlives the detached
capture worker. `commonwealth doctor` now reports how many decision candidates `autoAdr` vetoed and
how to change it, plus an aggregate of every other drop class; `commonwealth status` shows the same
rollup in one line.
