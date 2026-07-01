# 4. License: Apache-2.0

- Status: Accepted
- Date: 2026-07-01
- Deciders: kristof (owner), Claude (orchestrator)
- Relates: GitHub issue #22

## Context

Commons is open source by strategy (see [vision](../00-vision.md)) — OSS is the
distribution and trust wedge. We must pick a license. The comparable cluster: GBrain
(MIT), Dust (MIT), Mem0 (Apache-2.0), Cognee/Graphiti (Apache-2.0).

## Decision

**Apache-2.0.**

Rationale: it is permissive (maximizes adoption, like MIT) _and_ includes an express
patent grant and contributor terms. For foundational infrastructure that other tools and
companies will build on — and that we may take into enterprise settings — the patent
grant is worth the marginally longer headers. Matches Mem0/Cognee, the infra-layer peers.

## Consequences

- Add `LICENSE` (Apache-2.0) and SPDX headers where appropriate.
- Contributions inbound under Apache-2.0; a lightweight DCO (`Signed-off-by`) rather than
  a CLA to keep contribution friction low. (Revisit if a CLA becomes necessary.)
- Compatible with our dependencies (MIT/Apache/ISC).

## Alternatives considered

- **MIT** — simplest and common in the cluster, but no explicit patent grant.
- **AGPL / source-available (BSL)** — would protect against a cloud competitor
  re-hosting, but throttles the adoption/trust wedge that is the whole GTM. Rejected for
  now; the hosted tier competes on convenience, not license restriction.
