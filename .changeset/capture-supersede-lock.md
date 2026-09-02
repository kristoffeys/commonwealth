---
"@cmnwlth/core": patch
"@cmnwlth/curate": patch
---

Run capture's supersession under the cross-process sync lock (#281). `supersedeNote` is a
read-modify-write of a note that already exists — the one capture write that atomic, one-fact-per-
file notes do not protect — and it ran unlocked on the default `autoPromote` path, so two concurrent
captures could lose one side's `superseded_by` with no conflict and no warning. It now takes the
same lock `consolidate`, `graduate`, `adopt` and the sync engine hold, releases it in a `finally`,
and on contention DEFERS rather than races: the note still reaches canon, and the skipped
supersession is reported on `CaptureResult.supersessionsDeferred` and persisted as a
`supersession-deferred` capture receipt so `doctor`/`status` can still see it after the detached
capture worker exits.
