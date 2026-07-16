# Commonwealth — a multiplayer second brain for teams

> The shared, agent-readable context every teammate's AI reads _before_ it acts.
> Instant onboarding. Anti-bus-factor. Plain markdown. Git-backed. Open source.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE) &nbsp;Published on npm as `@cmnwlth/*`.

Most teams have a personal-notes story (Obsidian, `CLAUDE.md`) and an enterprise-search story
(Glean, Notion AI). Nothing in between owns the **reasoning layer** of a small team — the _why_
behind decisions, the current work-state, the memory that would otherwise walk out the door with
whoever wrote it.

Commonwealth is that layer, made multiplayer:

- **Plain markdown, git-backed.** Your knowledge is files you own — diffable, portable, no
  proprietary store to be locked into.
- **Per-project brains.** Each project gets its own brain (one git repo). Everyone reads and
  writes it through their existing AI (Claude Code and Codex).
- **Agent-native.** Exposed over MCP, so a teammate's agent reads the brain before acting and
  writes back what it learns.
- **Conflict-free by design.** One fact per file with collision-proof names, so concurrent
  writers merge instead of clobbering each other.
- **Decisions are traced.** What was decided, when, by whom, and why — captured by default.
- **Secrets never sync.** API keys, tokens, and `.env`-style secrets are detected and blocked at
  capture and scrubbed before commit.
- **Open source**, Apache-2.0.

## How it fits together

```
Claude Code / Codex (every teammate)
     │   reads before acting · writes back what it learns   (MCP)
     ▼
  your brain  =  plain markdown in a git repo
     │   background sync: pull · commit · push · conflict-free merge
     ▼
  git remote (GitHub / GitLab / your own) — the team shares it
```

## Quick start

**Requirements:** Node ≥ 22 and git. Claude Code and/or Codex for the agent experience.

**See it in 60 seconds, no setup:**

```bash
npx @cmnwlth/cli demo
```

Scaffolds a throwaway brain for a fictional payments team and answers a few questions whose
answers live only in that team's notes. It cleans up after itself (`--keep` to poke around).

**Set up a brain for your project — one command:**

```bash
npm i -g @cmnwlth/cli     # or run any command with: npx @cmnwlth/cli <command>
cd your-project
commonwealth init
```

`init` is an interactive wizard (press Enter to accept each default). It:

1. Creates a brain for this project — or **joins** the one it already belongs to.
2. Lets you multi-select which folders to sync into the brain and which repos to **seed** from
   (mining git history, ADRs, and agent config like `CLAUDE.md` / `.cursorrules` / `AGENTS.md`).
3. Installs the Commonwealth **plugin** for the selected agent. Claude Code and Codex both get MCP
   plus host-specific lifecycle hooks; Codex also gets a generated `AGENTS.md` brain snapshot.
4. Sets up your capture scope. Sync then runs **automatically in the session lifecycle** — the
   plugin hooks commit/pull/push at session start and after each capture, no background service
   required (ADR-0032). A resident daemon is available as an opt-in profile for continuous
   propagation.

> After install, restart the selected agent and open a new session/thread so it loads the plugin.
> In Claude Code, `/mcp` should list the `commonwealth` server.
> In Codex, run `/hooks`, review Commonwealth, and trust the current hook definitions; unreviewed
> plugin hooks are skipped.

The default remains Claude Code for backward compatibility. Select Codex or both explicitly:

```bash
commonwealth init --agent codex
commonwealth init --agent both
```

You can also install either plugin directly — the repo is its own compatible marketplace:

```bash
claude plugin marketplace add kristoffeys/commonwealth
claude plugin install commonwealth@commonwealth

codex plugin marketplace add kristoffeys/commonwealth
codex plugin add commonwealth@commonwealth
```

Prefer to run non-interactively (CI, scripting)? Pass `--yes` to use defaults + flags:

```bash
commonwealth init --yes --agent both --sync ~/work/app --seed-repo ~/work/app --remote git@github.com:you/brain.git
```

Then open a Claude Code session or Codex thread in the project and ask it something your team
already knows. Both hosts inject relevant brain context and capture before compaction. Claude Code
captures at `SessionEnd`; Codex has no session-end event, so it performs throttled capture when an
agent turn reaches `Stop`. In Codex, `Stop` is a turn boundary, not the end of the thread.

## Everyday use

Once set up, talk to the brain through your AI in any session. The `commonwealth` CLI covers the
rest — every command resolves the right brain from the current directory automatically:

```bash
commonwealth add <folder> [--brain <dir>] # wire another folder to the brain, in one go
commonwealth registry <show|route|allow|deny|remove|default|pull>  # brain-resolution rules (see below)
commonwealth status                       # review queue + sync state
commonwealth recall <query>               # search the brain
commonwealth ask <question>               # a cited answer, synthesized from the brain
commonwealth reseed [<repo>] [--all]      # mine repo(s) into the brain again
commonwealth pending                      # notes awaiting review
commonwealth promote <id...> | --all      # approve staged notes into canon
commonwealth reject <id...>               # discard staged notes
commonwealth sync once                    # sync now (lifecycle hooks do this automatically)
commonwealth sync start|stop              # opt into/out of the continuous daemon profile
commonwealth service <install|uninstall|status|restart>  # run sync as an OS background service
commonwealth health                       # freshness / trust score for the brain
commonwealth map                          # brain-at-a-glance: per-kind counts + top contributors
commonwealth project list                 # engagement links: which sources are one project
commonwealth project link <id> <src...>   # link a dev repo + business folder into one engagement
commonwealth project unlink <id> [<src>]  # undo a link (derived views only; no notes change)
commonwealth project adopt <id> [--dry-run]  # promote a proven link into note frontmatter (one commit), then retire the entry
commonwealth statusline [install]         # ambient status line for Claude Code (see below)
commonwealth graduate [--suggest]         # propose facts recurring across ≥2 brains to the org-brain
commonwealth doctor [--fix]               # diagnose (and optionally fix) the setup
commonwealth update --agent both          # update the CLI + refresh both host integrations
commonwealth --version                    # print the installed CLI version
```

The CLI checks npm at most once a day and prints a note on stderr when a newer version is
published (TTY only, never in CI; set `COMMONWEALTH_NO_UPDATE_CHECK=1` to silence it).

### Capturing decisions

Decisions are first-class. Commonwealth records decisions it detects in a session automatically;
to be sure a business or team decision is on the record — or to log one that never touched a
coding session — use the deliberate path inside Claude Code:

```
/commonwealth:decide  we're standardizing on Postgres for the ledger, not DynamoDB
```

It writes a `decision` note capturing **what** was decided, **when**, **who** decided it, and
**why** — so a later reversal *supersedes* it rather than erasing the reasoning.

### Review vs. auto-promote

By default, captured notes go **straight into canon** after the dedup + secret gates. To hold
them in a review queue for approval instead, flip the per-brain flag (it syncs with the brain):

```bash
commonwealth config set autoPromote false   # require manual review
commonwealth pending                         # see what's waiting
commonwealth promote <id...> | --all         # approve into canon
```

### Ambient status line

Show the brain at a glance in Claude Code's status line — name, freshness score, and
pending-review count — so "is it working?" and "is anything waiting for me?" are answered without
running a command:

```bash
commonwealth statusline install     # add it to ~/.claude/settings.json (then restart Claude Code)
```

Renders e.g. `🧠 antenna · 87/100 · 3 pending · ⇅` (the `⇅` shows only when the optional sync
daemon profile is live; with the default daemonless lifecycle sync it's simply omitted. `pending`
shows only when the queue is non-empty). It reads a cached status the SessionEnd hook
refreshes, so it stays well under the status line's per-turn latency budget — no git or index work
happens on render. `commonwealth statusline uninstall` removes it; a hand-written `statusLine` is
never clobbered. (Claude Code doesn't let a plugin register a main status line, so this one-time
`install` writes the entry into your own settings.)

### Graduate shared knowledge to an org-brain

When the same fact recurs across several project brains — a convention, a shared-infra rule — it
can **graduate** to an _org-brain_ everyone reads. Graduation is opt-in and safe by default:

```bash
commonwealth org-brain set ~/brains/org   # designate the org-brain (once, per machine)
commonwealth graduate --suggest           # scan wired brains; stage recurring facts for review
```

A note is only ever considered when it carries `graduate: true`, and even then it must recur
across **≥2 distinct brains** to be proposed. Candidates are **staged for manual review** in the
org-brain (with `sources:` back-links to where they came from) — never auto-promoted across the
trust boundary, regardless of any brain's `autoPromote`. Rejecting a candidate records a
**reject-tombstone** in the org-brain, so the same cluster is not re-proposed on the next run (it is
skipped with a `(previously rejected — N suppressed)` note); `commonwealth graduate --include-rejected`
resurfaces them. See [ADR-0023](docs/adr/0023-org-brain-graduation.md).

### Route projects to brains (rules)

Which brain a directory reads and writes is decided by an ordered **ruleset** ([ADR-0024](docs/adr/0024-rule-based-brain-resolution.md)). A rule matches by **git identity** or **path**, and routes to a brain, denies capture, or falls through to a default brain:

```bash
commonwealth registry default ~/brains/antenna       # the brain bare "allow" rules route to
commonwealth registry allow  'org:weareantenna/*'    # all repos of an org → the default brain
commonwealth registry route  repo:weareantenna/erp ~/brains/erp   # one repo → a different brain
commonwealth registry deny   repo:weareantenna/secrets           # never capture this repo
commonwealth registry route  'path:~/scratch' ~/brains/scratch   # a path (non-repo dirs, monorepos)
commonwealth registry show                           # list rules and the default brain
commonwealth registry remove repo:weareantenna/erp   # drop a rule
```

**Share rules with your team** ([ADR-0024 §5](docs/adr/0024-rule-based-brain-resolution.md)). Add `--shared` and the rule lives in the brain's committed config instead of your machine-local one, so it syncs to every teammate — the `repo → brain` _intent_ is portable even though each person's brain _path_ differs:

```bash
commonwealth registry route repo:weareantenna/erp ~/brains/erp --shared  # the team routes erp here
commonwealth registry deny  repo:weareantenna/secrets --shared           # a team-wide deny
commonwealth registry pull                                               # materialize teammates' shared rules
```

Shared rules are materialized into your local config automatically on `sync`; `pull` does it on demand. Your **local** rules always override a shared rule for the same matcher, so a personal deny or reroute is never clobbered by the team's — and personal (`local`, the default) rules never sync.

A **matcher** is one of:

| Matcher              | Matches                                             | Example                       |
| -------------------- | -------------------------------------------------- | ----------------------------- |
| `repo:<owner/repo>`  | an exact repo (by its git `origin`)                | `repo:weareantenna/erp`       |
| `org:<owner>`        | every repo of an owner                             | `org:weareantenna` (or `…/*`) |
| `path:<dir>`         | a path prefix — for non-repo dirs & monorepo subtrees | `path:~/scratch`          |
| `*`                  | everything (the catch-all)                         | `commonwealth registry allow '*'` |

**Precedence** (most specific wins): `repo` > `org` > `path` (longest) > `*`. A **deny** wins on a tie. A bare **allow** (no brain) routes to the `default` brain; an unmatched directory captures nothing.

Because `repo`/`org` match on git identity, a rule **follows a repo across every worktree, clone, and machine** — one `org:weareantenna/*` line covers all of Antenna's repos and all their branch worktrees, which path prefixes never could. Quote matchers containing `*` so your shell doesn't expand them.

> `commonwealth add <folder>` writes a rule for you: a `repo:` rule when the folder is a git repo with an `origin` (so it follows that repo everywhere), otherwise a `path:` rule.

### Keep personal projects out (scope)

A per-user, local allow/deny list decides which folders are ever captured or injected — personal
projects stay out. It lives in `~/.commonwealth/config.json` and is never synced.

```bash
commonwealth scope allow ~/work          # only capture work under here…
commonwealth scope deny  ~/work/secret   # …except this (deny wins)
commonwealth scope check                 # → in-scope | out-of-scope (for the cwd)
```

Rule: in scope if `(allow is empty OR under an allow entry) AND under no deny entry`. With no
config, everything is in scope; add a deny (or a narrow allow) to exclude.

Scope only decides *whether* capture may happen in a folder — *which brain* the folder writes to
is a separate mapping. To bring a new project folder in, don't `scope allow` it by hand; run

```bash
commonwealth add ~/work/new-project      # allowlist + brain mapping + symlink, in one go
```

which wires it to the brain your current directory resolves to (or pass `--brain <dir>`).

### One engagement, many sources (project identity)

A note records **where** it was captured in its `source` (the git `origin` slug for a repo, the
folder name otherwise) — honest provenance that is never rewritten. But one real engagement often
spans several sources: a customer's dev repo *and* their business folder. Link them into one
**project** so every grouped view — `COMMONWEALTH.md`, health — reads as a single engagement:

```bash
commonwealth project link acme "weareantenna/acme-website" "Acme Website"
commonwealth project list                 # see the engagement and its member sources
commonwealth project unlink acme          # undo — derived views only, no note changes
commonwealth project adopt acme           # once the link is proven, bake it into the notes
```

Linking is always explicit (never a fuzzy name-match), it touches **no note files**, and it is
retroactive: existing notes regroup the moment you link. A working folder can also declare its
identity up front with a `.commonwealth/project.json` manifest (`{ "project": "acme", "customer":
"Acme Corp" }`) — capture then stamps the project onto new notes and the customer as a
`customer:<slug>` tag. The alias map is the retroactive/corrective layer; the manifest is the
save-time path. (See [ADR-0031](docs/adr/0031-project-identity-resolved-at-read-time.md).)

Once a link has proven correct, **adopt** it: `commonwealth project adopt acme` stamps the resolved
`project` (and `customer:<slug>` tag) onto every linked historical note's frontmatter in one
reviewable commit, then retires the now-redundant alias entry — the identity now lives on the notes
themselves (`--dry-run` previews the counts first). Adoption refuses on a dirty worktree, never
touches a note that already declares a different project (reported as a conflict), and leaves the
derived views byte-identical (the read-time and save-time tiers resolve the same way).

## Optional: run sync as a continuous background service (daemon profile)

You usually don't need this. By default sync runs **in the session lifecycle** (ADR-0032) — the
plugin hooks commit/pull/push at session start and after each capture, so a fresh install converges
with no resident process. The **daemon profile** below is opt-in for cases that want *continuous*
background propagation regardless of sessions: headless/server installs, shared machines, or
high-frequency teams. When the daemon is live, the lifecycle hooks stand down (it owns sync).

`commonwealth sync start` runs the daemon in the **foreground** (it holds the terminal). To keep a
brain syncing across logout and reboot, install it as a **user-level service** that auto-restarts
on crash:

```bash
cd <a wired folder>            # or pass --dir <brain>
commonwealth service install   # generate + load the service, syncing that brain
commonwealth service status    # is it loaded / active?
commonwealth service restart   # reload (e.g. after picking up a new binary)
commonwealth service uninstall # unload + remove it
```

Per OS, `install` generates and loads a user-level unit — no root, nothing system-wide:

| OS      | Mechanism                                                             | Auto-restart          |
| ------- | -------------------------------------------------------------------- | --------------------- |
| macOS   | a LaunchAgent plist in `~/Library/LaunchAgents/be.commonwealth.sync.plist` | `KeepAlive` (on crash) |
| Linux   | a `systemd --user` unit `~/.config/systemd/user/commonwealth-sync.service` (with `enable-linger` so it runs while logged out) | `Restart=always` |
| Windows | a Scheduled Task `CommonwealthSync`, at logon                        | restart-on-failure    |

`commonwealth update` **restarts an installed service automatically** so the freshly updated binary
is loaded — you don't have to remember to. Logs go to `~/Library/Logs/commonwealth-sync.log`
(macOS) or the systemd journal (`journalctl --user -u commonwealth-sync`).

## Configuration

Commonwealth keeps a few small files, deliberately separate:

| File                                | Scope        | Synced? | Holds                                                                      |
| ----------------------------------- | ------------ | ------- | ------------------------------------------------------------------------- |
| `~/.commonwealth/config.json`       | per-user     | no      | your **brain-resolution rules** + default brain, and the **scope** allow/deny |
| `<brain>/.commonwealth/config.json` | in the brain | yes     | brain **name**, remotes, and **feature flags** (team-shared)              |

Two files, disambiguated by location: the per-user one under `~/.commonwealth/` is machine-local and never synced (your rules and personal denies stay yours); the one inside a brain syncs to the whole team.

Team-wide **feature flags** live in the brain config and are toggled with the CLI:

```bash
commonwealth config list                     # name, remotes, and all flags
commonwealth config set autoAdr false        # opt a brain OUT of decision tracking
commonwealth config set semanticDedup true   # smarter dedup (see below)
```

- **`autoAdr`** (default **on**) — records decision notes (auto-detected and via
  `/commonwealth:decide`). Set false to stop tracking decisions in a brain entirely.
- **`autoPromote`** (default **on**) — captured notes land in canon directly; set false to
  require manual review.
- **`semanticDedup`** (default **off**) — also catch near-duplicate notes phrased differently
  ("auth uses JWT" vs "we authenticate with bearer tokens"), using embeddings. Runs on-machine by
  default (no note text leaves the box) and needs an optional model package installed on enable.
- **`semanticSearch`** (default **on**) — hybrid retrieval: when an embeddings provider is
  configured, `recall`/`ask`/search fuse a semantic (embedding) ranking with the lexical one, so
  paraphrases and stopword-heavy questions ("did we use Shopware before?") still find the note.
  Inert for brains with no provider (behaves exactly like lexical-only), and set it `false` to force
  lexical-only even with a provider. Reuses the same vectors as `semanticDedup`, so existing brains
  need one index rebuild to backfill vectors for notes captured before either was enabled.
- **`llmCurator`** (default **on**) — an LLM curation pass in the capture pipeline
  ([ADR-0030](docs/adr/0030-llm-curation-pass.md)): a durability judge filters trivia the length
  check can't, and a consolidation classifier catches paraphrased updates (supersedes the older
  note) and contradictions of canon (flags them — never auto-rejected). Keeps autoPromote canon
  clean without human review. Runs in the plugin hook layer over the same host runtime as capture,
  so it is inert without a runtime (behaves exactly like today); any classifier failure fails open
  to the deterministic gate. Set `false` to skip the pass.

## Docs

| Doc                                                  | What it covers                                          |
| ---------------------------------------------------- | ------------------------------------------------------- |
| [`docs/05-quickstart.md`](docs/05-quickstart.md)     | Get a brain running for one project in minutes          |
| [`docs/06-self-host.md`](docs/06-self-host.md)       | Share a brain across a team over your own git remote    |
| [`docs/07-agent-parity.md`](docs/07-agent-parity.md) | Claude Code/Codex parity, lifecycle mapping, and health |
| [`docs/01-architecture.md`](docs/01-architecture.md) | How it works: git substrate, concurrency, the auto-bridge |
| [`docs/02-data-model.md`](docs/02-data-model.md)     | The markdown schema: memory / decisions / work-state / people |
| [`docs/03-distribution.md`](docs/03-distribution.md) | Distribution into Claude Code and Codex                 |
| [`docs/04-roadmap.md`](docs/04-roadmap.md)           | What's shipped and what's next                          |
| [`docs/release-checklist.md`](docs/release-checklist.md) | Fresh-marketplace release proof for both hosts       |

## License

[Apache-2.0](LICENSE) © 2026 Kristof Feys
