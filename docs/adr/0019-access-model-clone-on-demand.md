# 19. Access model: git permissions are the ACL; brains clone on demand

- Status: Proposed
- Date: 2026-07-05
- Deciders: kristof (owner) — _pending acceptance_; Claude (orchestrator, proposer)
- Relates: [ADR-0003](0003-concurrency-model.md), [ADR-0006](0006-sync-resident-daemon.md),
  [ADR-0011](0011-brain-wiring-global-registry.md), [ADR-0013](0013-brain-is-a-git-repo-at-init.md),
  [distribution §3 + "Access control = git permissions"](../03-distribution.md), issue #15

> This ADR is a **proposal for the owner to accept or amend**. It changes no behavior on its own;
> it records the intended access model and the clone-on-demand design so implementation can follow.

## Context

Two questions have been answered informally in `docs/03-distribution.md` but never ratified as a
decision, and the second is not yet implemented:

1. **What is the access-control model?** The distribution doc states plainly: "we deliberately
   don't build an ACL layer — a brain is a git repo; who can read/write is who has repo access on
   the host." Nothing in the code contradicts this, but it has never been recorded as a decision,
   so it keeps resurfacing ("do we need per-note permissions / roles / sharing?").

2. **How does a teammate get a brain they don't have locally yet?** Today the resolver
   (`resolveBrainDir`, ADR-0011) can return a brain **path** from a registry mapping (layer 3) or
   env var (layer 4) that **does not exist on disk** — it does not check existence for those
   layers. `init` _creates_ a brain (and can add a `--remote`), and `verify-restore` clones into a
   throwaway temp dir (#136), but nothing **clones a mapped-but-missing brain into place** so a
   joiner can start reading/writing it. The distribution doc promises "if the brain isn't cloned
   locally yet, the daemon clones it," but that path does not exist yet.

Both are genuinely hard-to-reverse: an access model shapes the security story and every
integration, and clone-on-demand decides where credentials, first-run latency, and failure modes
live. Hence an ADR.

## Decision (proposed)

### 1. Git host permissions **are** the access-control layer. We build no ACL.

- Read access = the user's git identity can `clone`/`fetch` the brain repo. Write access = it can
  `push`. Enforcement is the git host's (GitHub/GitLab/Gitea teams, deploy keys, SSO) — we never
  re-implement, cache, or second-guess it.
- There is **no per-note, per-kind, or per-user ACL**, no roles, no sharing UI, and no credential
  storage in Commonwealth. We rely on the user's existing git credential setup (SSH agent, git
  credential helper, `gh auth`). A brain a user can't access simply fails to clone/push, and we
  surface git's own error verbatim.
- Granularity is **per-brain** (= per-repo). Teams that need a knowledge boundary make a separate
  brain repo with its own repo permissions — the same tool split they already use for code.

This is a deliberate non-feature: it keeps the security model boring, auditable, and aligned with
what teams already trust (ADR-0003's "don't invent what git gives you," applied to auth). It is
also a differentiator vs. cloud stores that reinvent permissions.

### 2. A mapped-but-missing brain **clones on demand** from a recorded remote.

- A registry mapping (ADR-0011) gains an **optional `remote`** field:
  `{ prefix, brain, remote? }`. Onboarding records it when a remote is known (the `init --remote`
  URL, or the seeding repo's origin). The mapping's `brain` stays the local checkout path.
- When resolution selects a mapping whose `brain` directory **does not exist**, and the mapping has
  a `remote`, the resident daemon (ADR-0006) — or a one-shot `commonwealth sync` — **clones
  `remote` into `brain`** before its first sync, then proceeds normally. The clone runs under the
  user's git identity, so step 1's permission check happens for free: no access → clone fails → we
  report it and resolve nothing (the session degrades to no-brain, never a crash).
- `resolveBrainDir` itself stays **pure and side-effect-free** — it still just returns the resolved
  path (and now the mapping's `remote`, via a companion resolver that returns the full mapping).
  Cloning is an explicit action taken by the daemon/CLI, not a hidden effect of resolution, so
  read-only callers (search, `doctor`, `emit`) never trigger a network clone.
- Clone-on-demand is **idempotent and lock-guarded** (reuse the ADR-0006 cross-process lock): two
  processes racing the first clone of the same brain must not both write it.

### 3. Non-goals (explicit, so they stop resurfacing)

- No credential management, token vault, or "connect your GitHub" flow inside Commonwealth.
- No fine-grained authorization below the repo. No read/write split beyond what git gives.
- No server component and no central directory of brains — the registry is per-user and local
  (ADR-0011), and the org-wide brain directory is a git host concern.

## Consequences

- **Positive.** Zero ACL surface to build, test, or breach. Joining is "clone-and-go": a mapping
  with a `remote` is all a teammate needs; the daemon materializes the brain on first use.
  Auditing "who can see this knowledge?" reduces to "who has access to this repo?" — a question
  security teams already know how to answer.
- **First-run latency & offline.** The first resolution of a not-yet-cloned brain pays a `git
  clone`. If the user is offline or unauthenticated, it fails; we surface git's message and
  `doctor` (#134) already reports "brain resolves to `<path>` but that directory is missing" with a
  fix. `doctor` should gain an explicit "not cloned yet / clone failed" state.
- **Private brains over HTTPS** need a working git credential helper; SSH remotes need an agent key.
  This is standard git setup, but the quickstart/self-host docs must call it out, because a silent
  auth failure otherwise reads as "Commonwealth is broken."
- **Registry schema change.** Adding optional `remote` is backward-compatible (readers ignore
  unknown/absent fields; ADR-0011's writer already round-trips). Mappings written before this land
  simply have no `remote` and never clone-on-demand — the pre-existing "brain must already exist"
  behavior, unchanged.
- **Interaction with `verify-restore` (#136).** That command already clones from `origin`; this
  ADR generalizes the same "a brain is restorable from its remote" property into the normal join
  path.

## Alternatives considered

- **Build an ACL layer (roles, per-note visibility).** Rejected: enormous surface, duplicates the
  git host, and contradicts the "git is the substrate" principle. Teams that need a boundary split
  the repo.
- **A central Commonwealth access server / brain directory.** Rejected: introduces the server,
  account, and lock-in we explicitly avoid (vision, ADR-0004/0011). The git host already is the
  directory and the authority.
- **Clone eagerly at `init`/registration for every mapping.** Rejected: forces network + auth at
  wiring time for brains a user may never open on this machine; lazy clone-on-first-use is cheaper
  and matches how the daemon already works.
- **Store the remote in a per-project `.commonwealth/origin` marker instead of the registry.**
  Rejected: scatters state into project trees — exactly the clutter ADR-0011 moved _out_ of
  projects and into the global registry. Keep the remote next to the mapping.

## Implementation sketch (non-binding, if accepted)

1. `@cmnwlth/core`: add optional `remote` to `RegistryMapping`; add a resolver that returns the
   full matched mapping (path + remote) alongside the existing `resolveBrainDir`; add
   `ensureBrainCloned(brainDir, remote)` (lock-guarded, idempotent, no-op if `brain` exists).
2. `@cmnwlth/sync` daemon + one-shot: call `ensureBrainCloned` before the first sync when the
   resolved brain dir is absent and a `remote` is known.
3. Onboarding: record `remote` in the mapping it writes (`init --remote`, or the seed repo origin).
4. `doctor`: add a "brain not cloned yet / clone failed (auth?)" check with the exact git fix.
5. Docs: quickstart/self-host note the git-credential prerequisite for private brains.
