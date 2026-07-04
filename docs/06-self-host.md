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

## Current distribution caveat

Today the plugin runs from this local checkout (its runtime is bundled locally by
`packages/plugin/scripts/bundle.mjs`, invoked by `pnpm build`/onboarding). Installing the plugin
on a teammate's machine straight from GitHub without a local build is **not yet supported** — the
vendored runtime isn't committed (it carries a platform-specific native binary). npm publishing
and a zero-build install are on the roadmap (see issues #49 and #62). Until then, each teammate
builds the CLI once as in the Quickstart.
