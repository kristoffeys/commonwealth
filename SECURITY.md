# Security policy

Commonwealth is a shared, git-backed knowledge store, so its security model centers on two
promises:

- **Secrets never sync.** Credentials are detected and blocked at capture and scrubbed
  pre-commit (note files _and_ the generated `COMMONWEALTH.md`/`INDEX.md`), so a leaked key is
  never committed or pushed — including across a rebase conflict. High-entropy detection with a
  per-brain allowlist is opt-in (`secretScan`).
- **Reads and writes stay inside the brain.** Note paths and ids are contained to the brain
  directory; a crafted path/id cannot escape it.

## Reporting a vulnerability

Please report privately — do **not** open a public issue for a security problem.

- Use GitHub's **[Report a vulnerability](https://github.com/kristoffeys/commonwealth/security/advisories/new)**
  (the repo's Security tab → "Report a vulnerability"). This opens a private advisory only the
  maintainer can see.

Include what you were doing, the impact, and a minimal repro if you have one. You'll get an
acknowledgement, and a fix + coordinated disclosure once it's understood. There's no bounty (this
is a pre-1.0 open-source project), but credit is offered in the advisory unless you'd rather not.

## Scope

In scope: the CLI, MCP server, sync engine, curation/secret gates, and the Claude Code plugin
hooks in this repository. Out of scope: third-party dependencies (report upstream), and misuse of
a brain you control (e.g. deliberately committing a secret with the scanner disabled).

## Supported versions

Pre-1.0: only the latest release / `main` is supported. Fixes land on `main` and the next release.
