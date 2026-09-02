# 44. Agent-assisted ingestion: the host's own connectors are the fetch layer for OAuth sources

- Status: Accepted
- Date: 2026-09-02
- Deciders: kristof (owner), Claude (orchestrator)
- Relates: [ADR-0043](0043-external-ingestion-candidate-producer-contract.md) (the
  `capture --external` entry point this tier hands candidates to, and the `ExternalCandidate`
  schema it reuses), [ADR-0032](0032-daemonless-lifecycle-sync.md) (the session-lifecycle
  discipline this tier's human-triggered nature is consistent with), [ADR-0019](0019-access-model-clone-on-demand.md)
  (git-permissions-as-ACL — the model this tier deliberately does not widen), issue #150

## Context

ADR-0043 formalizes a *deterministic* connector: pure code, no interactive auth, runnable headless
under `commonwealth ingest <id>`. Four of the sources #150 asks about — Slack, Notion, Gmail, Jira —
need OAuth to reach at all, and OAuth is not a small addition: acquiring, refreshing, and securely
storing tokens for four providers is weeks of infrastructure, and it is infrastructure with real
legal weight (Commonwealth would become the party holding credentials and, functionally, a
sub-processor of whatever content those tokens can see).

The obvious prior art here is [openhuman](https://github.com/tinyhumansai/openhuman)'s own traction
story: roughly a hundred first-party OAuth integrations, pulling on a schedule into a service it
operates. That shape does not fit us and we are deliberately not copying it. Commonwealth is a git
repo on the user's own disk with no server and no token store; building an OAuth estate to reach
sources means operating the single most expensive, most legally-loaded, least differentiating thing
available to us — to reach sources the user's *host agent* is frequently already authenticated to.
This very investigation ran inside a session with live MCP connectors for Slack, Notion, Gmail,
Atlassian, and Productive, none of which Commonwealth had to build or hold a credential for.

## Decision

1. **Commonwealth ships no OAuth client and stores no third-party token, for this tier, ever.**
2. **For Slack/Notion/Gmail/Jira (and any source that needs OAuth to reach), the fetch is performed
   by the host agent, through the connectors the user already has** — not by Commonwealth code.
   Shape: a `/commonwealth:ingest <source> <selector>` command whose skill instructs the agent to
   read the named channel/space/thread/mailbox through its own tools, distill candidates against
   the documented `ExternalCandidate` schema (ADR-0043), and hand them to
   `commonwealth-curate capture --external --force` — the **identical** entry point a Tier A
   (ADR-0043) connector uses. Commonwealth ships the schema, the prompt, the allowlist check, and
   every gate downstream of `captureCandidates`; it never sees, requests, or stores a credential.
3. **This is Tier B of a two-tier model.** Tier A (ADR-0043): deterministic, in-process, headless,
   cursored, runs under `commonwealth ingest`. Tier B (this ADR): agent-assisted, needs a live
   session, human-triggered by construction. Both tiers converge on the same runner-owned gating
   and landing (ADR-0045); only the fetch differs.
4. **The accepted cost, stated plainly: Tier B cannot run headless or on a schedule.** It needs a
   session and a host agent to drive it. For #150's actual goal — time-to-first-value on a cold
   brain — that is not a limitation: "open a session, run
   `/commonwealth:ingest slack #design-decisions`, get sixty notes" is the flow, and it is a
   one-time or occasional action, not a background service. This is consistent with, not a workaround
   of, ADR-0032's decision that the reliable component (the session lifecycle) should drive things,
   not a resident process.
5. **A source proves it needs unattended recurrence, then — and only then — it is promoted to
   Tier A** (a native ADR-0043 connector, with its own OAuth acquisition if that is truly
   warranted), decided with evidence from actual Tier B usage, not speculatively up front.

## Rejected

- **Build native OAuth connectors for Slack/Notion/Gmail/Jira ourselves.** The expensive,
  legally-loaded, non-differentiating rung on the ladder (ADR-0043's infrastructure inventory: I7,
  "the expensive rung"). Every one of these sources is reachable another way today.
- **Skip these sources entirely until native connectors are built.** Leaves real product value
  (design docs, decisions embedded in chat, ticket context) off the table for no necessary reason —
  the agent-assisted tier captures most of it at near-zero engineering and zero credential risk.
- **Have Commonwealth request narrow read-only OAuth scopes itself, "just for reading."** Still
  means holding a token and being the party a workspace admin grants access to; the marginal safety
  of a narrower scope does not change who is holding it.

## Consequences

- "Your knowledge is files you own" stays literally true: no third party — including
  Commonwealth-the-project — ever holds a token on the team's behalf for this tier.
- Consent and audit are inherited from the host for free: whatever UI and logging the user's Slack/
  Notion/Gmail/Jira MCP connector already has for access review applies here unchanged.
- The connector estate for OAuth sources scales with the host ecosystem (more MCP connectors exist
  over time) rather than with Commonwealth's own engineering capacity to build and maintain OAuth
  clients.
- Honest limitation, not a hidden one: no unattended recurrence for these sources in v1. A team that
  wants continuous Slack ingestion does not get it from this ADR.
- `ExternalCandidate`'s non-optional `excerpt` (ADR-0043) matters more here than anywhere else: the
  agent doing the fetching is a general-purpose host agent, not a purpose-built connector, so the
  verbatim-source-plus-link discipline is the check against a paraphrase quietly drifting from what
  a Slack message or email actually said.

## Not deciding yet

- **NDA/consent scope for ingesting client-adjacent content** (design investigation's Open
  Question 1). Antenna is an agency; importing a client-adjacent Slack channel or Notion space
  re-publishes it to a new audience (the git remote's ACL, ADR-0019) and may make Commonwealth's
  operator a sub-processor under a client contract. This can legitimately kill specific selectors
  on non-engineering grounds. Not resolved here; must be answered before any Phase 3 selector
  documentation ships for client-adjacent workspaces.
- **Email: in or out** (Open Question 2). The design investigation's recommendation is *out* — an
  individual's mailbox is correspondence with third parties who never consented to republication —
  with a shared alias (`hello@`, `projects@`) as the only acceptable in-scope shape if it is ever
  wanted. This ADR does not decide it; it is Kristof's call before an email selector is documented.
- **The concrete `/commonwealth:ingest` skill/command implementation and per-source selector docs**
  (Phase 3 of #150's plan). Not filed as issues yet — they depend on this ADR being accepted and on
  Open Questions 1 and 2 being answered first.
- **Whether any Tier B source is later promoted to Tier A.** The promotion criterion (evidence of a
  real recurrence need) is stated above; no source is pre-committed to that path.
