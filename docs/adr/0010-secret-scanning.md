# 10. Secret scanning: built-in regex default, pluggable, gitleaks optional

- Status: Accepted
- Date: 2026-07-01
- Deciders: kristof (owner), Claude (orchestrator)
- Relates: [architecture](../01-architecture.md), issue #16

## Context

A shared, synced brain must never carry credentials. We need to detect secrets and stop
them entering (at capture) or leaving (at pre-commit). Options ranged from a small hand-
rolled regex set to hard-depending on a mature scanner. Reference tools reviewed:
[gitleaks](https://github.com/gitleaks/gitleaks) (~150 rules + entropy),
[SecretFinder](https://github.com/m4ll0k/SecretFinder) (broad provider regex set), and
[detect-secrets](https://github.com/Yelp/detect-secrets) (entropy plugins + a
baseline/allowlist workflow).

## Decision

**A built-in regex scanner in `@commons/core` (`secrets.ts`) is the zero-dependency
default**, with detection **inspired by** the gitleaks / SecretFinder rule sets:

- Provider patterns (AWS, GitHub token/PAT, Anthropic, OpenAI incl. `sk-proj-`/
  `sk-svcacct-`, Google API + OAuth, Slack token + webhook, Stripe, SendGrid, npm,
  Twilio) plus a token-bounded generic `NAME = value` assignment matcher that catches
  compound/env-var identifiers (`aws_secret_access_key=`, `OPENAI_API_KEY=`) while
  avoiding look-alikes (`secretary =`, `tokenize …`).
- Enforced in **two places**: curate rejects secret-bearing candidates at capture
  (`contains-secret`); the sync daemon scrubs them pre-commit (unstages tainted note
  files, reports `secretsBlocked`, leaves them uncommitted to fix).
- Previews are masked; the raw secret is never returned or logged.

**We deliberately do NOT hard-depend on gitleaks.** It's a Go binary; requiring it (and
bundling it per-platform into the plugin) would break the zero-config, self-contained
ethos. Instead the scanner is designed to be **pluggable**: an optional gitleaks backend
(used when present) is a tracked follow-up, mirroring the pluggable-`Embedder` pattern
(ADR-0005).

## Consequences

- Works out of the box with no external tooling; covers the credentials people actually
  paste. Zero false positives on the tested benign look-alikes.
- Not exhaustive vs gitleaks' full ruleset, and has **no entropy detection** (so a novel
  high-entropy secret matching no named pattern can slip through) and no allowlist yet —
  accepted for now. The tracked follow-up adds **entropy-based detection + a
  baseline/allowlist** (detect-secrets model) and an **optional external backend**
  (gitleaks/detect-secrets) for teams that want maximum coverage.
- Regex maintenance burden as new key formats appear (e.g. the OpenAI `sk-proj-` shift
  this ADR already had to absorb) — another reason the pluggable backend matters.

## Alternatives considered

- **Hard-depend on gitleaks** — best coverage, but a mandatory Go binary; rejected as the
  default to preserve zero-config. Kept as an optional backend (follow-up).
- **No scanner / rely on review** — rejected; a single missed paste leaks a live
  credential into a synced repo. Defense-in-depth (capture + pre-commit) is worth it.
