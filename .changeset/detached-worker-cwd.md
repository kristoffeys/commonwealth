---
"@cmnwlth/plugin": patch
---

Fix silent capture loss in Orca task worktrees (#259): the detached SessionEnd capture-worker and the extractor/curate children it spawns no longer force a `cwd` that Orca deleted on teardown, which used to throw ENOENT and degrade into a generic "no durable knowledge" receipt. A new `spawnCwd()` guard drops a vanished cwd (children inherit the worker's pinned-stable cwd), and the detached spawns pin a stable cwd via `detachedWorkerCwd()`. The real project path still reaches curate as `--cwd <payload>`, so brain resolution is unchanged.
