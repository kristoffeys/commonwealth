---
description: Ask the team brain a question and get a cited answer
argument-hint: [your question]
---

# /commonwealth ask

Answer the user's question from the team brain, **with faithful citations** (ADR-0020).

Steps:

1. Call the `commonwealth` MCP server's **`ask`** tool with the user's question (`$ARGUMENTS`).
   It returns the most relevant notes as citation-anchored context — it does **not** write the
   answer; you do.
2. Write a tight answer **using only the returned notes**. Cite every claim with its note **id**
   and **path** (e.g. `(memory/2026-07-01-jwt-a1b2.md)`). Use the `read` tool to pull a full note
   when an excerpt isn't enough.
3. If `coverage.matched` is false, or the returned notes don't actually address the question, tell
   the user you **don't have enough in the brain to answer** — never invent facts or citations.

Keep it conversational and short. The citations are the value: every claim must trace to a real
note the user can open.

> If the `commonwealth` MCP server isn't available in this session, fall back to the CLI:
> `!commonwealth ask "$ARGUMENTS"` — it prints the same cited retrieval for you to synthesize from.
