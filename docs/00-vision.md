---
title: Vision & Positioning
type: decision
status: draft
updated: 2026-07-01
tags: [strategy, positioning, competition]
---

# Vision & Positioning

## The bet

Small teams lose the **reasoning layer** constantly. Documents capture _what_ was
decided; chat captures _noise_; nobody captures _why_ — the context, the rejected
options, the current work-state, the live threads with people. When someone leaves,
or just forgets, that layer is gone. Every AI a teammate runs starts cold.

**Commonwealth is the context substrate every team member's AI reads before it acts.**
It makes the personal `~/vault` pattern multiplayer: a remote, shared, per-project
brain of plain markdown, git-backed, that agents read and write.

Two payoffs:

- **Instant onboarding** — a new member's (or new agent's) first action is to read the
  brain, not to interrupt someone.
- **Anti-bus-factor** — reasoning is captured as work happens, owned by the team, not
  trapped in one head or one vendor.

## Who it's for

Small, project-based teams (our shape: **Antenna**, ~dozens of people, many concurrent
client/product projects). Not enterprise-search buyers. Not solo note-takers.

## The competitive landscape (2026)

Four clusters, each missing at least one leg of what we do:

**1. Agent-native markdown memory — our category.**

- **GBrain** (Garry Tan, OSS MIT, Apr 2026, ~5k stars day one). Markdown →
  self-wiring knowledge graph, wires into Claude Code/Codex, autonomous cron ingestion.
  **Gap: single-player.** No team/concurrency story.
- **basic-memory** (markdown + MCP + Obsidian; hosted team cloud $15/mo). Closest
  _product_. **Gap: proprietary cloud, not git; conflict resolution is mtime-wins
  (silent overwrites).**
- **COG-second-brain**, **akitaonrails/ai-memory** — OSS "markdown wiki in git for
  coding agents." Prove the pattern; single-user, hobby-scale.

**2. Memory-layer APIs.**

- **Mem0** ($24M Series A Oct 2025, Apache-2.0, ~48k stars) — the default "bolt memory
  onto an agent" API. **Gap: vector/graph _service_, not human-editable markdown, not
  git, not a browsable team brain.** Opaque to people.
- Letta/MemGPT, Zep, Cognee — same shape (agent infra, not a knowledge substrate).

**3. Enterprise work-AI / RAG-over-connectors.**

- **Dust** (OSS MIT, $29/user), **Glean** ($50–65/user, proprietary, enterprise sales).
  RAG over SaaS connectors. **Gap: knowledge is ephemeral in their index — no durable,
  portable, owned artifact.** Wrong size/motion for small teams.

**4. Wikis with an MCP bolt-on.**

- **Notion** (markdown-ish MCP, but Business/Enterprise-only), Confluence+Rovo, Slite,
  Guru, Tana. **Gap: proprietary store, not git; agent-readability is an afterthought.**

**5. Git-native coding-agent memory — the on-target cluster (all 2025/2026, unproven).**
This is where the fight actually is. New entrants converging on our exact idea:

- **Kage** (kage-core.com) — **the closest single match.** Plain markdown in your repo
  (YAML frontmatter, verification fields), auto-wires Claude Code/Codex/Cursor via MCP,
  memory injected each prompt, verifies memory against actual code (`kage pr check`),
  "**memory reviewed in git, same PR as the code.**" **Gap: sharing is manual git-pull,
  NOT auto-push/materialize into each teammate's config; single-remote; brand-new.**
- **Mainline** (mainline.sh) — agents auto-save decisions as **git refs/notes**.
  **Gap: git-notes, not human-editable markdown you browse and PR.**
- **Letta Code MemFS** — git-backed markdown, one commit per memory edit. **Gap:
  subagent-coordination oriented (worktrees), no human-team shared-repo mode, and it
  aims to _replace_ Claude Code rather than augment it.**
- **Context Cloud / Agentage / Tulsk** — team workspaces or cross-tool sync, but
  proprietary-cloud (Context Cloud) or remote-server-of-record (Agentage), not pure git.

### Where nobody plays

| Property                            | GBrain | basic-memory | Mem0 | Dust/Glean | Notion |
| ----------------------------------- | ------ | ------------ | ---- | ---------- | ------ |
| Plain markdown, human-editable      | ✅     | ✅           | ❌   | ❌         | ~      |
| Git-backed / you own the data       | ✅     | ❌           | ❌   | ❌         | ❌     |
| Multiplayer / team                  | ❌     | ✅           | ~    | ✅         | ✅     |
| Per-project brains                  | ~      | ✅           | ~    | ~          | ✅     |
| Agent-native (MCP, read-before-act) | ✅     | ✅           | ✅   | ✅         | ~      |
| Auto-curate + push/fetch relevance  | ✅     | ❌           | ~    | ~          | ~      |
| Open source                         | ✅     | ✅           | ✅   | ✅         | ❌     |

**The recurring fault line: git-backed and true-multiplayer are mutually exclusive
everywhere.** Obsidian (unofficial obsidian-git _or_ paid Sync), Logseq (git-friendly OG
_or_ multiplayer DB alpha), basic-memory (single-user git _or_ paid CRDT cloud), Cursor
(git Rules _or_ DB Memories), Claude Code itself (git `CLAUDE.md` _or_ machine-local auto
memory). **Whoever fuses the two cleanly wins.**

**Our edge is the intersection nobody combines:**
`git-backed ownership` **×** `true multiplayer with real concurrency` **×** `open source`
**×** `the "auto" bridge`.

- GBrain / Kage / Mainline have git + OSS but no team auto-propagation (Kage: manual
  pull; GBrain: single-player; Mainline: git-notes not markdown).
- basic-memory has multiplayer + markdown but is closed cloud with mtime-wins merges.
- Mem0 / Dust / Cognee / Zep are OSS but not a markdown brain you own and browse — opaque
  vector/graph indexes behind an API.
- Enterprise (Glean, Copilot, Gemini, Sana) is RAG-over-connectors: derivative, rented,
  seat-floored (~100 seats / $60k+), and Copilot memory is _per-user, never team-shared_.

**The two genuinely unsolved problems (this is the moat):**

1. **The "auto" bridge** — turning what an agent _learned this session_ into a
   _deduped, merge-clean, PR-reviewable_ commit that then **auto-lands in every
   teammate's next session**. Manual everywhere today.
2. **Relevance-gated push/fetch** — _which_ learned memory is worth sharing, and _when_
   to surface it into a teammate's active context. Essentially untouched by anyone.

## Strategy: wedge in on the sharp edge

The brain is a **chronic, not acute** pain, and the market is **crowded** — a hard
cold sell on its own. So we land on a sharp, monetizable wedge and expand into the brain:

- **Wedge (acute, monetizable): SOW-diff.** Same buyer, same tech stack — read existing
  tools → structured memory → surfaced insight → drafted action. Land on margin.
- **Expand (chronic, defensible): the brain.** Once the substrate exists to power
  SOW-diff, it _is_ the team brain. Same tech, same buyer.

**Open source is the go-to-market, not a nice-to-have.** GBrain's 5k-stars-in-a-day
proves OSS + the Claude Code wave is the distribution channel. OSS is our trust wedge vs.
basic-memory's closed cloud and our credibility vs. Mem0's not-a-product API.

## Risks (design around these)

1. **Anthropic eats the base case.** "Team memory sync" chatter + Agent Teams (Feb 2026).
   _Defense:_ be the open, git-backed, portable layer that works across Claude/Codex/
   Cursor — the opposite of lock-in.
2. **Concurrency is the real hard problem** — exactly where basic-memory (mtime-wins) and
   GBrain (single-player) are weakest. _Turn the moat on:_ git-native, conflict-free-by-
   design writes (see architecture).
3. **Chronic-not-acute demand.** _Defense:_ lead with the SOW-diff wedge, not "brain."
4. **Curation quality.** A brain that fills with contradictory junk is worse than no
   brain. _Defense:_ curation-as-review (agent proposes, human/PR approves).
5. **Fast-moving on-target startups (Kage, Mainline).** They're closest and shipping.
   _Defense:_ they're single-remote / manual-pull / not-multiplayer today — win on the
   team **auto-bridge + concurrency + relevance gating** before they add it, and out-
   community them with OSS + the Antenna dogfood proof.

## Non-goals (v1)

- Not a general enterprise search product.
- Not a real-time collaborative editor (git cadence, not Google-Docs cursors).
- Not a hosted-only SaaS — self-host / bring-your-own-git is a first-class path.
