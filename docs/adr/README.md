# Architecture Decision Records

We record significant, hard-to-reverse decisions as ADRs using a light
[MADR](https://adr.github.io/madr/) format. One file per decision, immutable once
`Accepted` — supersede rather than edit.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-implementation-stack.md) | Implementation stack: TypeScript + Node + pnpm monorepo | Accepted |
| [0003](0003-concurrency-model.md) | Concurrency: atomic files + union merge + derived indexes | Accepted |
| [0004](0004-license-apache-2.md) | License: Apache-2.0 | Accepted |
| [0005](0005-search-and-embeddings.md) | Search: SQLite FTS5 now, pluggable embeddings later | Accepted |

## Process

1. Copy the format of an existing ADR. Number sequentially.
2. Status: `Proposed` → `Accepted` / `Rejected`. Later decisions can mark an ADR
   `Superseded by ADR-XXXX`.
3. Link the ADR from the relevant GitHub issue (decision tickets carry `type:decision`).
4. Keep it short: Context → Decision → Consequences → Alternatives.
