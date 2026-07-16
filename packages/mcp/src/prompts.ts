import { z } from "zod";

/**
 * MCP prompt definitions — the Commonwealth command set (`ask`, `recall`, `remember`, `decide`,
 * `status`, `promote`) exposed to every MCP client (Cursor, Windsurf, Claude Desktop, Zed, and
 * Claude Code, which renders them as `/mcp__commonwealth__<name>`). This closes the multiplayer
 * gap: non-Claude-Code editors previously got read-only `emit` context but no verbs, so a
 * mixed-editor team could read the brain but not feed it (#216).
 *
 * SINGLE SOURCE OF TRUTH — the UPSTREAM wording lives in `packages/plugin/commands/*.md`. Those
 * markdown files are the human-facing slash commands for the Claude Code plugin; the prompt bodies
 * here are PORTED from them (the mechanics are re-pointed at MCP tool calls instead of the
 * vendored curate/sync CLIs, but the agent-facing instructions are the same prose). To keep the
 * two from silently drifting, every entry carries `driftAnchors`: verbatim excerpts that MUST
 * appear both in the rendered prompt AND in the corresponding command file. `prompts.test.ts`
 * asserts exactly that — edit a command's core instruction and the test names the divergence.
 *
 * These definitions are STATIC: they don't change at runtime, so we do not emit
 * `notifications/prompts/list_changed`. Registering them still advertises the `prompts` capability
 * (with `listChanged` support) via the SDK. If prompt bodies ever become brain-configurable, the
 * server should call `server.sendPromptListChanged()` on change.
 */

/** A single prompt argument, mapped to a zod string schema in {@link promptArgsSchema}. */
export interface PromptArgDef {
  name: string;
  description: string;
  /** Optional args are `.optional()` in the schema and may be absent when rendered. */
  required: boolean;
}

/** A ported command → MCP prompt definition. */
export interface PromptDef {
  /** Prompt name, matching the plugin command (e.g. `ask`). */
  name: string;
  /** Human title shown by clients. */
  title: string;
  /** Short description — ported from the command's frontmatter `description`. */
  description: string;
  /** The upstream command file (basename in `packages/plugin/commands/`), for the drift guard. */
  commandFile: string;
  /** Declared arguments. */
  args: PromptArgDef[];
  /**
   * Verbatim excerpts of the command file. Each MUST be a substring of both the command markdown
   * and this prompt's rendered body — the drift guard checks both directions.
   */
  driftAnchors: string[];
  /** Render the prompt body from its (already-validated) arguments. */
  render: (args: Record<string, string | undefined>) => string;
}

/** Build the zod raw-shape for a prompt's arguments (MCP prompt args are always strings). */
export function promptArgsSchema(def: PromptDef): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const arg of def.args) {
    const base = z.string().describe(arg.description);
    shape[arg.name] = arg.required ? base : base.optional();
  }
  return shape;
}

/** The six ported prompts. Bodies are faithful ports of `packages/plugin/commands/*.md`. */
export const PROMPTS: PromptDef[] = [
  {
    name: "ask",
    title: "Ask the team brain",
    description: "Ask the team brain a question and get a cited answer",
    commandFile: "ask.md",
    args: [{ name: "question", description: "Your question for the team brain", required: true }],
    driftAnchors: [
      "Answer the user's question from the team brain, **with faithful citations**",
      "never invent facts or citations.",
    ],
    render: ({ question }) =>
      [
        "# Ask the team brain",
        "",
        "Answer the user's question from the team brain, **with faithful citations** (ADR-0020).",
        "",
        `**Question:** ${question ?? ""}`,
        "",
        "Steps:",
        "",
        "1. Call the `commonwealth` MCP server's **`ask`** tool with the question above. It returns " +
          "the most relevant notes as citation-anchored context — it does **not** write the answer; " +
          "you do.",
        "2. Write a tight answer **using only the returned notes**. Cite every claim with its note " +
          "**id** and **path** (e.g. `(memory/2026-07-01-jwt-a1b2.md)`). Use the `read` tool to pull " +
          "a full note when an excerpt isn't enough.",
        "3. If `coverage.matched` is false, or the returned notes don't actually address the " +
          "question, tell the user you **don't have enough in the brain to answer** — never invent " +
          "facts or citations.",
        "",
        "Keep it conversational and short. The citations are the value: every claim must trace to a " +
          "real note the user can open.",
      ].join("\n"),
  },
  {
    name: "recall",
    title: "Recall from the team brain",
    description: "Recall relevant knowledge from the team brain",
    commandFile: "recall.md",
    args: [
      { name: "query", description: "Optional search query to narrow the recall", required: false },
    ],
    driftAnchors: ["Surface relevant knowledge from the team brain for the current work."],
    render: ({ query }) => {
      const q = query?.trim();
      return [
        "# Recall from the team brain",
        "",
        "Surface relevant knowledge from the team brain for the current work. This is the same " +
          "relevance-gated selection the SessionStart hook injects automatically — use it to pull " +
          "context on demand (optionally narrowed by a query).",
        "",
        q
          ? `Call the \`commonwealth\` MCP server's **\`search\`** tool with the query "${q}" (and ` +
            "the **`read`** tool to open any hit in full), then present the relevant notes to the user."
          : "Call the `commonwealth` MCP server's **`search`** tool for the topic at hand (and the " +
            "**`read`** tool to open any hit in full), then present the relevant notes to the user.",
      ].join("\n");
    },
  },
  {
    name: "remember",
    title: "Remember into the team brain",
    description: "Stage a note into the team brain's review queue (memory by default)",
    commandFile: "remember.md",
    args: [
      { name: "text", description: "What to remember (the fact / knowledge)", required: true },
      {
        name: "kind",
        description: "Note kind: memory (default), decision, work-state, or person",
        required: false,
      },
    ],
    driftAnchors: [
      "Manually capture a piece of knowledge into the team brain's **staging review queue**",
      "The note kind defaults to `memory`.",
    ],
    render: ({ text, kind }) => {
      const k = kind?.trim() || "memory";
      return [
        "# Remember into the team brain",
        "",
        "Manually capture a piece of knowledge into the team brain's **staging review queue** " +
          "(ADR-0007). It goes through the same curation as automatic capture — the secret gate, " +
          "dedup, and the brain's `autoPromote` setting — so it lands in canon (autoPromote on) or " +
          "the review queue (off), and may be declined (e.g. a secret or a near-duplicate).",
        "",
        "The note kind defaults to `memory`. If it is a clear decision, prefer the `decide` prompt.",
        "",
        `**Kind:** ${k}`,
        `**Content:** ${text ?? ""}`,
        "",
        "Call the `commonwealth` MCP server's **`remember`** tool, choosing an appropriate short " +
          "`title` and passing the content above as the `body` and the kind above as `kind`. Then " +
          "report the outcome back to the user: the note id and whether it landed in canon or is " +
          "pending review until promoted.",
      ].join("\n");
    },
  },
  {
    name: "decide",
    title: "Record a decision in the team brain",
    description: "Record a team/business decision in the brain (what, when, who, why)",
    commandFile: "decide.md",
    args: [
      { name: "what", description: "The decision that was made", required: true },
      { name: "why", description: "The rationale: problem, options weighed, why this one won", required: false },
      { name: "deciders", description: "Who decided (comma-separated names/handles)", required: false },
    ],
    driftAnchors: [
      "Deliberately record a **decision**",
      '- **Title** — a short, specific statement of the decision (e.g. "Use Postgres for the ledger").',
      "**by whom**, and **why**.",
    ],
    render: ({ what, why, deciders }) =>
      [
        "# Record a decision in the team brain",
        "",
        "Deliberately record a **decision** — a business or team choice, an assumption being locked " +
          "in, a direction that was picked — into the team brain, so there is a durable trace of " +
          "**what** was decided, **when**, **by whom**, and **why**.",
        "",
        `**Decision:** ${what ?? ""}`,
        why ? `**Why:** ${why}` : "",
        deciders ? `**Deciders:** ${deciders}` : "",
        "",
        "Before recording, make the trace complete — infer what you can from the conversation and " +
          "ask the user only for what's genuinely missing:",
        "",
        '- **Title** — a short, specific statement of the decision (e.g. "Use Postgres for the ledger").',
        "- **Why** — the rationale: the problem, the options weighed, and why this one won. This is " +
          "the most valuable part; put it in the body. Note key **assumptions** the decision rests on.",
        "- **Who** — the deciders. Use the people's names/handles.",
        "- **When** — recorded automatically (today's date); no action needed.",
        "- **Status** — `accepted` for a decision that's been taken, `proposed` if it's still a proposal.",
        "",
        "Then record it by calling the `commonwealth` MCP server's **`remember`** tool with " +
          "`kind: \"decision\"`, a short decision statement as the `title`, and the what/why/options/" +
          "assumptions in the `body`. Report the note id back to the user; if it was staged (not " +
          "promoted), remind them it is pending review until promoted.",
      ]
        .filter((line) => line !== "")
        .join("\n"),
  },
  {
    name: "status",
    title: "Team brain status",
    description: "Show the team brain's pending review queue and sync status",
    commandFile: "status.md",
    args: [],
    driftAnchors: [
      "Give the user a quick health check of their team brain: what is waiting in the review queue",
    ],
    render: () =>
      [
        "# Team brain status",
        "",
        "Give the user a quick health check of their team brain: what is waiting in the review queue " +
          "and whether the local brain is in sync with its remote.",
        "",
        "1. Call the `commonwealth` MCP server's **`list-work-state`** tool to show what workstreams " +
          "are currently planned, in progress, or blocked, and use **`search`** to surface anything " +
          "recently added.",
        "2. Summarize for the user: what is active, and (if they run the CLI) remind them they can " +
          "check the review queue and sync with `commonwealth status`.",
      ].join("\n"),
  },
  {
    name: "promote",
    title: "Promote staged notes into canon",
    description: "Approve staged notes into canon (or list what is pending)",
    commandFile: "promote.md",
    args: [
      { name: "ids", description: "Space-separated note ids to approve (empty = list pending)", required: false },
    ],
    driftAnchors: [
      "Approve one or more **staged** notes into the brain's canonical folders (ADR-0007).",
      "staged notes never become canon until promoted.",
    ],
    render: ({ ids }) => {
      const idList = ids?.trim();
      return [
        "# Promote staged notes into canon",
        "",
        "Approve one or more **staged** notes into the brain's canonical folders (ADR-0007). Approval " +
          "is the review gate: staged notes never become canon until promoted. Approved notes are " +
          "written as fresh atomic files and are what actually syncs to the team (ADR-0008).",
        "",
        idList
          ? `Approve these note ids: **${idList}**. Promotion is a curation step performed with the ` +
            "`commonwealth promote` CLI (or the plugin's `/commonwealth:promote` command); the MCP " +
            "tool surface is read/capture only, so relay the ids to the user to approve and report " +
            "the canonical paths for each promoted note."
          : "No ids were given — first show the user what is pending review (use the `search` tool " +
            "or the `commonwealth status` CLI), so they can choose which staged notes to approve " +
            "with `commonwealth promote <id...>`.",
      ].join("\n");
    },
  },
];
