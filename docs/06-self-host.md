# Self-host guide

Commonwealth's OSS core tier is **self-hostable with zero vendor lock-in**: the brain is an
ordinary git repo you own, synced over any git remote you control (GitHub, GitLab, a bare repo on
your own box). There is no Commonwealth server, no database to run, and no account. See
[docs/03-distribution.md](./03-distribution.md) for the tiering rationale.

## The pieces

- **Brain repo** — plain markdown notes (`memory/`, `decisions/`, `work-state/`, `people/`) plus
  a generated `COMMONWEALTH.md` router. The source of truth.
- **Git remote** — any remote all teammates can push/pull. This _is_ the sync backbone.
- **Sync daemon** — a local, resident process per teammate that commits local changes, pulls
  teammates' work on a poll interval, resolves same-file conflicts as siblings (no data loss),
  and pushes. One per machine; a cross-process lock keeps a one-shot `sync` from racing it.
- **Per-user scope config** (`~/.commonwealth/config.json`, never synced) — which directories are
  in capture scope (ADR-0008).
- **Registry** (`~/.commonwealth/registry.json`, never synced) — maps each project directory to
  its brain.

## Stand up a shared brain

1. **Create the brain and its remote.** On the machine of whoever seeds it first:

   ```bash
   cd ~/work/my-project
   commonwealth init --remote git@github.com:my-org/my-project-brain.git
   ```

   `--remote` sets the brain repo's `origin`; the daemon pushes the seeded canon up. (No remote
   yet? Run `init` without it, create the empty remote, then
   `git -C <brain> remote add origin <url> && commonwealth sync once`.)

2. **A teammate joins.** They build the CLI (see the [Quickstart](./05-quickstart.md)), then from
   the same project run `commonwealth init`. When a brain already exists for the project they
   **join** it (clone-and-go, time-to-first-value ≈ 0) rather than re-seeding. The daemon keeps
   both clones converged.

3. **Keep it converged.** `init` starts the daemon detached; control it with:

   ```bash
   commonwealth sync start | once | stop
   commonwealth status        # is the daemon running? what's in the queue?
   ```

## Per-brain configuration (committed, team-wide)

The brain's `.commonwealth/config.json` is committed, so these apply to everyone (ADR-0009):

- **`features.autoPromote`** (default **on**) — captured notes promote straight to canon (gates
  still run). Set `false` to hold captures in the review queue for `commonwealth promote`.
- **`features.autoAdr`** (default off) — auto-create decision notes when a decision is captured.
- **`secretScan`** (default `{ "entropy": false, "allowlist": [] }`) — opt into high-entropy
  secret detection beyond the named patterns, with an allowlist for accepted values (#46).

Toggle feature flags with `commonwealth config` / `commonwealth-curate feature enable <name>`;
edit `secretScan` directly in the committed config file.

## Mixed-tool teams — `commonwealth emit`

Not everyone is on Claude Code. `commonwealth emit` writes the current project's team-brain slice
into the generated context files Cursor, Copilot, and Codex already honor — so those teammates read
the brain with **zero runtime integration** (no MCP server, no plugin):

```bash
commonwealth emit            # regenerate the context files for this repo
commonwealth emit --commit   # track them in git instead of gitignoring
```

It writes two wholly-owned files — `.cursor/rules/commonwealth.mdc` and
`.github/instructions/commonwealth.instructions.md` — plus a sentinel-fenced block in `AGENTS.md`
(your own content around the block is preserved). Every file is marked "generated — do not edit";
regenerate with `emit`, never hand-edit (ADR-0003, pointed outward).

By default the wholly-owned files are **gitignored** — they're per-machine derived output and would
otherwise churn in teammates' diffs. Pass `--commit` to track them (e.g. to hand the context to
teammates who won't run `emit` themselves). The rendered slice is deterministic and token-budgeted,
and contains only canon (superseded notes are excluded).

## Scope — control what gets captured (per user)

Capture is gated by your per-user scope so personal or out-of-bounds projects never feed the
shared brain:

```bash
commonwealth scope allow ~/work        # only capture work under here…
commonwealth scope deny  ~/work/secret # …except this (deny wins)
commonwealth scope check               # in-scope | out-of-scope for the cwd
commonwealth scope show
```

Rule: in scope if `(allow is empty OR under an allow entry) AND under no deny entry`.

## Secrets never leave the brain

Credentials are detected and **blocked at capture** and **scrubbed pre-commit** (defense in
depth) — covering note files _and_ the generated `COMMONWEALTH.md`/`INDEX.md`, and non-ASCII
paths. A withheld note is reported and left uncommitted in your working tree to fix. This holds
even across a rebase conflict. Tune detection per brain via `secretScan`.

## Trust & decay

Run `commonwealth health` for a freshness/trust score plus counts of stale, unverified,
contradicted, and orphaned notes — so a lead can see the brain rotting before it does.

Because two teammates can independently capture the same fact, run `commonwealth consolidate`
periodically to reconcile cross-user near-duplicates: it supersedes duplicates onto a single
survivor (supersede-not-delete — the files are kept), single-writer and safe to re-run. Preview
with `--dry-run` (ADR-0017).

## When something's off — `commonwealth doctor`

The setup spans five parts that fail silently: the plugin install, brain resolution for your cwd,
a dangling `.commonwealth/brain` marker, a dead sync daemon (→ a stale brain), and remote lag /
review-queue depth / index freshness / scope. `commonwealth doctor` walks the whole chain and
prints pass/fail with the exact one-line fix per failed link:

```bash
commonwealth doctor          # human-readable pass/fail + fixes
commonwealth doctor --json   # structured report for agents/CI (exit 1 if any link failed)
commonwealth doctor --fix    # self-heal — restarts a dead daemon (the only auto-fix)
```

Paste the output into any support thread — it's the first triage step. Exit code is non-zero when a
critical link failed, so CI can gate on it.

## Prove you can restore it — `commonwealth verify-restore`

"Your knowledge is portable git you own" is only worth as much as your last successful restore.
`commonwealth verify-restore` clones the brain into a throwaway temp dir and *proves* full recovery
— every note schema-valid, ids unique, supersede chains resolving, no secrets in canon, and the
derived `COMMONWEALTH.md`/`INDEX.md` regenerating byte-for-byte — then prints an **RPO** line (the
age of the last commit = your worst-case data-loss window). Exit code is 0 only when recovery is
verified, so it's a green/red CI gate.

```bash
commonwealth verify-restore                # prove the committed local state restores
commonwealth verify-restore --from-remote  # the real off-site proof: clone origin and verify
commonwealth verify-restore --json         # structured report for CI / dashboards
```

### Weekly CI gate (GitHub Actions)

Drop this in the **brain repo** at `.github/workflows/verify-restore.yml`. It re-clones the brain
from its own remote every Monday and fails the run if recovery can't be proven:

```yaml
name: verify-restore
on:
  schedule:
    - cron: "0 6 * * 1" # 06:00 UTC every Monday
  workflow_dispatch: {}
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx -y @cmnwlth/cli verify-restore --from-remote
        env:
          COMMONWEALTH_BRAIN_DIR: ${{ github.workspace }}
```

A green check every week is the proof an eng lead wants *before* a team migrates tribal knowledge
in — and doubles as the backup/compliance answer.

### Offline escrow (`git bundle`)

For an air-gapped/off-platform copy, a brain is just a git repo, so snapshot it into a single file
you can store anywhere (S3, a USB drive, a safe):

```bash
git -C <brain> bundle create brain-$(date +%F).bundle --all
# restore later, anywhere: git clone brain-2026-07-05.bundle recovered-brain
```

That's the whole export story — no proprietary format, no `export` command to trust.

## Distribution

The `@cmnwlth/*` packages are published to npm (#49), so no build or committed runtime is needed:

- **CLI:** `npm i -g @cmnwlth/cli` (or `npx @cmnwlth/cli init`).
- **Plugin:** installing it from the marketplace works from a bare clone — its MCP server and hooks
  run the published packages on demand via `npx` (`@cmnwlth/mcp`, `@cmnwlth/curate`), which pulls
  `better-sqlite3`'s per-platform prebuilt binary transitively (#62). No platform-locked vendor.

Building from source (the [Quickstart](./05-quickstart.md)) remains supported for development.
