---
"@cmnwlth/core": minor
"@cmnwlth/cli": minor
---

A brain no longer takes notes about itself (#268). Automatic, hook-driven capture is suppressed when the session's working directory is at or inside the brain it resolved to — a brain resolves to itself, so administering it (publishing the vault, fixing the registry, tidying notes) used to write that session's chatter back into canon as real notes, inflating counts and skewing `map`/`health`. The gate compares realpaths, so a session reached through the `~/.commonwealth/brains/<name>` symlink is caught too, and it is case-folded on case-insensitive filesystems. It applies to the shared capture path, so Claude and Codex behave identically.

Only AUTOMATIC capture is affected: `/commonwealth:remember`, `/commonwealth:decide`, and `commonwealth reseed` still record deliberately, and context injection still works inside the brain. The suppression is never silent — the session receipt says the session ran from inside the brain and names the explicit commands, the capture log records a `self-capture` skip, and `commonwealth doctor` warns when your cwd is inside a brain. `@cmnwlth/core` exports the `isCwdInsideBrain` predicate.
