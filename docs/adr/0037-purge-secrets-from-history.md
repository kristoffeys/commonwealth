# 37. Purge leaked secrets from git history (destructive rewrite + force-push)

- Status: Accepted
- Date: 2026-09-02
- Deciders: kristof (owner), Claude (orchestrator)
- Relates: [ADR-0010](0010-secret-scanning.md) (secret scanning: capture + pre-commit gates), issue #271

## Context

Secret scanning (ADR-0010) enforces two write-gates: curate rejects secret-bearing candidates at
capture, and the sync daemon scrubs tainted note files pre-commit. Both are **forward** guards — they
stop a credential entering a _new_ commit. Neither does anything about a secret that is _already in
history_.

The concrete failure that motivates this ADR: a note carries a live `AKIA…` key, and a later commit
"redacts" it by replacing the value with a placeholder **in the working tree**. HEAD now looks clean,
`git grep` finds nothing, and everyone assumes the leak is handled. But the raw value still sits in
the prior commit's blob: `git log -p` recovers it, and so does every clone and the shared remote. A
working-tree redaction is not a history redaction.

Git offers no in-place edit of an old blob — the only way to remove the bytes is to **rewrite
history** (every commit from the tainted one forward gets a new SHA) and, because the brain is
multiplayer and synced, to **force-push** the rewrite so the shared remote no longer serves the old
objects. Both are destructive operations we otherwise never do (ADR-0003: "never silently overwrite";
sync never force-pushes). So this needs to be an explicit, human-gated remediation, not an automatic
one.

## Decision

Add an explicit `commonwealth redact` command (sync bin `redact-history`) that purges leaked
credentials from a brain's **entire git history** and force-pushes the rewrite to scrub the shared
remote.

- **Scan ALL history, not the working tree.** Discovery streams every blob in the object database
  (`git cat-file --batch --batch-all-objects`), skips binaries, and runs the _same_ brain-configured
  detector the write-gates use (`findSecretsForBrain`) over each blob's text. This is what catches the
  secret that survives only in a prior blob. The raw literal is recovered exactly as elsewhere
  (`text.slice(index, index + length)`) and used only as a rewrite key; **only masked previews +
  kinds + counts are ever surfaced** — the raw value is never logged, printed, or placed on a command
  line or in an env var. The one place a raw literal touches disk is the replace-text spec file,
  created `0600` in a private temp dir and unlinked in a `finally`.

- **Rewrite engine: `git filter-repo` preferred, `git filter-branch` fallback.** filter-repo is the
  modern, fast, recommended tool but is a separate install; when it is absent we fall back to
  filter-branch so the feature works out of the box, and `--engine filter-branch` forces the fallback
  (so CI without filter-repo still covers that path). Each leaked literal is rewritten to the same
  `[REDACTED:<kind>]` placeholder the working-tree redactor uses. The filter-branch tree-filter runs a
  Node helper that does a literal `replaceAll` over each checked-out tree — never `sed` over secret
  bytes — and afterward deletes `refs/original/*`, expires the reflog, and prunes so the old blobs are
  gone locally too.

- **Explicit confirmation, `--dry-run`, and never from the daemon.** The command prints the masked
  impact summary and requires the user to type the brain's name to proceed; `--yes` skips it (scripts/
  CI) and `--dry-run` stops after discovery. It is deliberately a standalone command wired only into
  the CLI, **never into the background sync daemon or the lifecycle hooks** — a force-push that resets
  every teammate's clone must be a deliberate, supervised act.

- **Force-push + teammate recovery.** After rewriting locally it force-pushes `origin/<branch>` (and
  tags, whose targets move), then prints the exact recovery steps teammates must run
  (`git fetch origin && git reset --hard origin/<branch>`), with the warning that any unpushed local
  work must be rebased onto the new history by hand.

The command also reminds the operator that **rewriting history does not un-leak an exposed
credential** — the secret was already served to every clone and must be rotated/revoked regardless.
Purge is damage-limitation, not a substitute for rotation.

## Consequences

- The leak the forward gates cannot fix now has a remedy: the raw value is removed from every commit,
  from local history, and from the shared remote (a fresh clone no longer carries it).
- It is genuinely destructive and multiplayer-expensive: every teammate's clone diverges and must be
  hard-reset, and unpushed local work needs a manual rebase. This cost is why it is human-gated and
  daemon-excluded — the recovery instructions are part of the command's output, not an afterthought.
- filter-branch is slow (it checks out every commit) and the fallback path will lag filter-repo on
  large histories; acceptable, since redaction is a rare remediation, not a hot path.
- Force-push assumes the operator's git identity may push the branch (ADR-0019: git permissions are
  the ACL). A protected branch or a remote that denies non-fast-forwards will reject the push with
  git's own error — the operator resolves it out-of-band (temporarily lift protection, or coordinate).

## Alternatives considered

- **BFG Repo-Cleaner** — excellent at exactly this, but a bundled JAR (a JVM dependency), which breaks
  the zero-heavy-dependency ethos the same way a mandatory gitleaks binary did (ADR-0010). filter-repo
  (optional) + filter-branch (always present) keeps us dependency-light.
- **Only redact the working tree / rely on rotation alone** — rejected. Rotation is necessary but
  leaves the old value in history forever; anyone with a clone or read access to the remote can still
  read it. Purging shrinks the exposure window and satisfies "no secrets in the brain" as an
  auditable state, not just a going-forward promise.
- **Automate it from the daemon on detection** — rejected outright. A silent force-push that
  hard-resets the whole team is the opposite of the "never silently overwrite" principle; the blast
  radius demands a human in the loop.
