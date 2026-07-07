# 24. Rule-based brain resolution: match by git identity or path → brain, deny, or default

- Status: Accepted
- Date: 2026-07-07
- Deciders: kristof (owner); Claude (orchestrator)
- Relates: [ADR-0008](0008-curation-locality.md) (per-user scope/privacy gate),
  [ADR-0011](0011-brain-wiring-global-registry.md) (**superseded** — the prefix→brain registry),
  [ADR-0015](0015-note-project-provenance.md) (`resolveProjectSource`: git identity → `owner/repo`),
  [ADR-0019](0019-access-model-clone-on-demand.md) (per-mapping `remote`, clone-on-demand),
  [ADR-0023](0023-org-brain-graduation.md) (org-brain pointer); implemented by #182, motivated by
  the worktree capture gap; #180 (rate-limit PTY silent-skip) shipped separately

## Context

Two independent systems decide what Commonwealth does in a given directory:

1. **Routing** — `resolveBrainDir` (`@cmnwlth/core/registry.ts`, ADR-0011): a `prefix → brain`
   map in `~/.commonwealth/registry.json`, longest prefix wins.
2. **Scope/privacy** — `isInScope` (`@cmnwlth/curate/scope.ts`, config `~/.commonwealth/config.json`):
   `{ allow: string[], deny: string[] }`, where `inScope = (allow empty || under allow) && not under deny`.

Two files, two schemas, two match functions, consulted separately by the hooks — for what a
user experiences as one question ("what happens when I work here, and where does it go?"). This
split is confusing and, worse, **fragile because both key off filesystem paths**. The same logical
repo appears at many paths — clones, per-machine checkouts, and especially **git worktrees**. Orca
creates per-branch worktrees as *siblings* of a base worktree (`…/workspaces/lemahieu` vs
`…/workspaces/lemahieu-ldc-wood-prices`); boundary-safe prefix matching means the sibling is *not*
under the registered base, so it resolves to no brain and captures nothing. This silently dropped
~a day of capture — path prefixes cannot express "this repo, wherever it is checked out."

A stable identity already exists: `resolveProjectSource` (ADR-0015) reduces a cwd to its git
`origin` remote as an `owner/repo` slug (falling back to repo basename, then cwd basename). It is
used today only to *tag note provenance* — never for resolution. And registry mappings already
carry a `remote` field (ADR-0019), but only for clone-on-demand, not as a match key. The pieces
for identity-based resolution are present; they were never wired into resolution.

## Decision

Replace the two path-keyed systems with **one ordered ruleset** that matches by **git identity or
path** and yields **a brain, a deny, or a fall-through to a default brain**. Routing and scope
become the same model.

### 1. A rule matches by identity OR path, and carries an outcome

```jsonc
{
  "defaultBrain": "~/projects/antenna-brain",   // optional; see §4
  "rules": [
    { "org":    "weareantenna/*" },                              // allow → defaultBrain
    { "prefix": "~/orca/workspaces" },                           // allow → defaultBrain
    { "repo":   "weareantenna/erp", "brain": "~/projects/erp-brain" },  // route elsewhere
    { "repo":   "weareantenna/secrets", "deny": true }          // deny
  ]
}
```

A rule has exactly one **matcher** — `repo` (exact `owner/repo`), `org` (`owner/*` — matches the
owner segment), or `prefix` (a `~`-expandable path prefix) — and one **outcome**: `brain` (route
here), `deny: true` (never capture here), or *neither* (a bare allow → the default brain, §4). A
matcher value of `"*"` in any field is the universal catch-all. `repo`/`org` are matched against
`resolveProjectSource(cwd)` (ADR-0015); identity matching is host-agnostic (the slug drops the
host), which is acceptable and documented — collisions across hosts are not a real concern for a
single user's registry.

### 2. Resolution order (first hit wins)

1. **Project marker** `.commonwealth/brain` — unchanged human override (ADR-0011 §2).
2. **Self-is-brain** `.commonwealth/schema-version` — unchanged (ADR-0011 §6).
3. **Rules** — the single **most-specific matching rule** decides, by a fixed specificity tier:
   `repo` (exact) > `org` (glob) > `prefix` (longest wins) > `*` (catch-all). **Deny wins on a
   tie** (equal specificity). The winner yields: `deny → denied`; `brain → that brain`;
   *no brain → defaultBrain*.
4. **Env** `COMMONWEALTH_BRAIN_DIR` — unchanged final fallback.
5. **None** — nothing matched → no-op.

This refines the earlier "deny always wins" to **most-specific wins, deny breaks ties**: a broad
deny can still be carved out by a more specific allow (`org acme/* deny` + `repo acme/public`
allow → `acme/public` is allowed), and a broad allow can be narrowed by a specific deny (`org
acme/* → brain` + `repo acme/secrets deny` → secrets denied). Both directions are intentional and
serve the stated use cases; deny-on-tie keeps the safe default when two rules of equal specificity
disagree.

### 3. Scope folds in — no separate allow/deny system

Resolution returns a three-way result: **`{ brain }` | `{ denied }` | `{ none }`**. This *is* the
scope gate:

- a routing rule (**bare allow** or `brain`) → in scope for that brain;
- a **`deny`** rule → out of scope (the old `deny` list);
- **no match** → no-op (the old "nothing configured here").

The standalone `allow` list dissolves: "matches a routing rule" already carries the allow
semantic. `config.json`'s `{ allow, deny }` is migrated into rules and then retired.

### 4. Default brain = the brain a *matched* rule uses when it names none

`defaultBrain` is **not** a catch-all for unmatched directories — it is the destination for a rule
that matched but specified no `brain`. This preserves the safe, opt-in default: an **unmatched**
cwd still resolves to `none` (never captured), so adding a default brain never turns on
capture-everywhere. Capture-everywhere is instead an **explicit, greppable** `*` rule
(`{ "prefix": "*" }` → defaultBrain, or `{ "prefix": "*", "brain": X }`). A bare-match rule with
no `defaultBrain` set is a no-op + warning at resolve time (never breaks a session); the CLI
refuses to add a brainless rule when no default brain exists.

### 5. Shareable routing vs local privacy

Identity-based routing rules mean the same thing on every machine (`weareantenna/* → the team
brain`), so they can eventually live **in the brain, committed and shared** across the team — the
"multiplayer" payoff a path-keyed registry could never deliver. Personal privacy (`deny
~/finances`) must **not** propagate to teammates. Rules therefore carry an origin — `local` (this
machine only, never synced; the default) vs `shared` — with local overriding shared. Only the
repo→brain *intent* is shareable; the brain *path* stays per-machine (registry / clone-on-demand).

### 6. One per-user config file

The two per-user, machine-local files — `~/.commonwealth/config.json` (scope allow/deny, ADR-0008)
and `~/.commonwealth/registry.json` (routing, ADR-0011) — **merge into a single
`~/.commonwealth/config.json`**. Since scope folds into rules (§3), this file simply *gains*
`rules` / `defaultBrain`; `registry.json` is retired (still read for back-compat, then removed by
`migrate`). One file now answers the whole "what happens when I work here, and where does it go?"
question.

The brain's own `<brain>/.commonwealth/config.json` (name, remotes, feature flags; ADR-0009) stays
**separate**: it lives inside the brain and **syncs to the whole team**, whereas the per-user file
is machine-local and never synced. Merging them would leak personal denies to teammates and cross
the local-vs-shared boundary (§5). The two are disambiguated by location (`~/.commonwealth/…` vs
`<brain>/.commonwealth/…`); brain identity remains keyed off `.commonwealth/schema-version`, not
`config.json` (ADR-0011 §6), so a per-user `config.json` under `$HOME` is never mistaken for a brain.

### 7. Back-compat, no forced migration

The legacy `mappings: [{ prefix, brain, remote? }]` array is still read and folded in as `prefix`
rules; the legacy `config.json` `{ allow, deny }` is read and folded in as allow/deny rules. Every
existing install keeps resolving exactly as before with zero user action. `resolveBrainDir`
(→ `string | null`) and `resolveBrainMapping` (→ `ResolvedBrain | null`) keep their signatures as
thin wrappers over the new resolver, so no caller breaks. A `commonwealth registry migrate`
command rewrites legacy files into the rule schema when the user opts in.

## Consequences

- **Worktrees, clones, and per-machine checkouts resolve correctly** via one `repo`/`org` rule —
  the #182 class of bug is designed out, not patched.
- **Org-level wiring in one line** (`weareantenna/* → brain`), covering present and future repos.
- **One model, one file, one mental picture**: match → brain | deny | default. The `config.json`
  scope layer is retired (kept readable for back-compat, then deprecated).
- **Identity resolution uses a single lazy `git config` call** (only when an identity rule is
  present, so path-only registries never invoke git). Both core (`resolveProjectSource`) and the
  **inlined** hook mirror use `git` rather than hand-parsing `.git/config`, because git resolves the
  worktree `.git`-file → `commondir` → shared `origin` chain transparently — which is exactly the
  worktree case this ADR exists to fix. Path-only and no-remote repos degrade gracefully (fall back
  to path rules / basename), never throwing.
- **Deterministic precedence** across two match axes via a fixed specificity tier + deny-on-tie,
  documented so the behavior is predictable.

## Alternatives considered

- **Keep two systems, just add worktree-following to the path resolver** (follow `.git` to the
  main repo path). Rejected: fixes local worktrees only, not clones on other machines, and leaves
  the two-file confusion and the routing/scope split intact.
- **Deny is absolute (any matching deny → denied).** Rejected: cannot carve an allow-exception out
  of a broad deny, forcing awkward inverted configs. Most-specific-wins + deny-on-tie is more
  expressive and still safe.
- **Default brain as an unmatched catch-all.** Rejected (owner): it silently flips the privacy
  default to capture-everywhere. The default brain applies only to matched-but-brainless rules;
  capture-everywhere must be an explicit `*` rule.
- **Replace path matching entirely with identity.** Rejected: non-repo dirs, no-remote repos, and
  monorepo sub-path routing still need paths. Identity is primary; path is retained.

Supersedes [ADR-0011](0011-brain-wiring-global-registry.md).
