---
"@cmnwlth/core": minor
"@cmnwlth/curate": minor
"@cmnwlth/cli": patch
---

Add a quiet-tick guard to the periodic maintenance passes (#273). `consolidate` and `graduate` now
fingerprint the notes they would read and skip the expensive similarity/embeddings stage entirely
when nothing has changed since the last successful run, reporting it as a no-op with the reason.
The checkpoint lives in the disposable `index/` area and advances only on success, so an
interrupted pass re-processes its window; `--force` demands a full pass.
