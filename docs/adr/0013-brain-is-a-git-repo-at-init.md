# 13. A brain is a git repository from the moment it is created

- Status: Accepted
- Date: 2026-07-01
- Deciders: kristof (owner), Claude (orchestrator)
- Relates: [ADR-0002](0002-implementation-stack.md), [ADR-0003](0003-concurrency-model.md),
  [ADR-0005](0005-search-and-embeddings.md), [architecture](../01-architecture.md), issue #66

## Context

Git is the substrate (ADR-0003): markdown files are the source of truth and every operation
— union-merge, supersede-not-delete, multiplayer sync — is a git operation. The sync engine
(`packages/sync`) runs `git add -A` / `commit` / `push`, and onboarding runs
`git remote add origin`. All of it assumes the brain directory **is** a git repository.

But nothing ever made it one. `initBrain` (`packages/core/src/scaffold.ts`) wrote the skeleton
— kind folders, `.gitkeep`s, `.gitattributes`, `.gitignore`, `COMMONWEALTH.md`, `.commonwealth/` —
and returned. No `git init`, no initial commit, and no other code path filled the gap: `onboard`
went scaffold → `setRemote` → `startDaemon`, each step silently assuming a repo already existed.

The failure mode is severe because git, run inside a directory that is not a repo, **walks up**
to the nearest ancestor `.git` and operates on *that*. In the field this produced: an accidental
`git init` at `~/projects` turned the entire projects tree into one working tree; the sync
daemon's `git add -A` (run in the brain) then resolved to `~/projects/.git` and tried to stage
every sibling project — emitting `CRLF will be replaced by LF` warnings for Windows-authored
files across unrelated repos and finally dying on a nested repo with
`'<repo>/' does not have a commit checked out`. Even with no stray parent repo, `setRemote` and
the first sync would have failed with `not a git repository`.

## Decision

1. **`initBrain` makes the brain a git repo with an initial commit**, as the final scaffold step.
   `@cmnwlth/core` gains a `git` shell-out (via `node:child_process`, no new dependency —
   git is already a hard runtime requirement of the sync layer). We chose core over the CLI
   onboard layer so that **every** caller of `initBrain` — CLI, tests, future callers — gets a
   valid, self-contained repo and the "a brain is a git repo" invariant lives with the scaffold.
2. **No-op when `.git` already exists.** A caller that set up its own repo (notably a `git clone`
   of an existing brain, as the multiplayer sync fixtures do) is respected untouched, and
   byte-idempotency of re-running `initBrain` is preserved.
3. **Fallback committer identity only when none is configured.** The initial commit uses the
   user's git identity when present, else a generic `Commonwealth <commonwealth@localhost>` via
   per-invocation `-c` flags, so init succeeds on a fresh machine or CI runner without ever
   overriding a real identity. Subsequent commits (daemon/user) use their own identity.
4. **Best-effort, never fatal.** If git is absent, too old, or the commit fails, `initBrain`
   degrades to the previous files-only behavior rather than throwing — it is never worse than
   before, and the mistake is contained to environments that cannot run the tool anyway.
5. **`.DS_Store` is git-ignored** in the scaffold, since macOS drops one into every brain folder.

## Consequences

- A freshly initialized brain is immediately operable: `setRemote`, the daemon's first commit,
  and multiplayer sync all have a repo rooted at the brain, so git can never escape upward.
- `@cmnwlth/core` now shells out to `git` (previously pure fs). This is acceptable given git
  is already required transitively; the call is isolated to `initGitRepo` and fully guarded.
- Existing brains created before this change are not a repo. The remedy is a one-time
  `git init -b main && git add -A && git commit -m "Initialize Commonwealth brain scaffold"` in
  the brain directory (and removal of any accidental ancestor `.git`).
- This ADR does not change the concurrency model (ADR-0003) or the derived-index rules (ADR-0005);
  it only guarantees the substrate those decisions assume.
