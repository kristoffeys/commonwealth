import { NOTE_KINDS, type Note } from "@commonwealth/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listWorkState, readNoteTool, remember, searchNotes, whoIs } from "./tools.js";

/** Zod enum of the four note kinds, reused across tool input schemas. */
const kindEnum = z.enum(NOTE_KINDS);

/** Compact one-line summary of a note for human-readable tool output. */
function summarizeNote(note: Note): string {
  const fm = note.frontmatter;
  const status = "status" in fm ? ` [${fm.status}]` : "";
  return `- ${fm.title}${status} (${note.path})`;
}

/** The MCP error-result shape returned by a tool: human text + `isError`. */
type ToolError = { content: { type: "text"; text: string }[]; isError: true };

/**
 * The explicit "no brain configured" result. Returned by every tool when the server was
 * built without a resolved brain (see {@link createServer}), instead of silently operating
 * on the process cwd. Tells the user exactly how to wire one up. (#64)
 */
function noBrainConfigured(): ToolError {
  const cwd = process.cwd();
  return {
    isError: true,
    content: [
      {
        type: "text",
        text:
          `No Commonwealth brain is configured for ${cwd}. Run \`commonwealth init\` here to ` +
          `create or join a brain, or add a prefix → brain mapping to ` +
          `~/.commonwealth/registry.json. (Set COMMONWEALTH_BRAIN_DIR to pin one explicitly.)`,
      },
    ],
  };
}

/**
 * Build the Commonwealth MCP server with the five M1 tools wired to the pure handlers in
 * `tools.ts`. Every tool reads/writes the brain only through `@commonwealth/core`, keeping
 * markdown the source of truth (ADR-0003).
 *
 * @param brainDir Absolute path to the brain repo, or `null` when {@link resolveBrainDir}
 *   found no brain for the cwd. When `null` the server still starts (so the plugin never
 *   breaks an unmapped project) but every tool returns {@link noBrainConfigured} rather than
 *   silently reading/writing the cwd. Defaults to the process cwd when omitted so a caller
 *   that already `cd`'d into a brain can build the server without resolving.
 */
export function createServer(brainDir: string | null = process.cwd()): McpServer {
  const server = new McpServer({ name: "commonwealth", version: "0.0.0" });

  server.registerTool(
    "search",
    {
      title: "Search the brain",
      description:
        "Full-text search across the team brain's notes (memory, decisions, work-state, " +
        "people). Optionally scope to one kind and cap the number of results.",
      inputSchema: {
        query: z.string().min(1).describe("Search terms"),
        kind: kindEnum.optional().describe("Restrict to a single note kind"),
        limit: z.number().int().positive().max(100).optional().describe("Max results (default 20)"),
      },
    },
    async ({ query, kind, limit }) => {
      if (brainDir === null) return noBrainConfigured();
      const results = await searchNotes(brainDir, { query, kind, limit });
      const text =
        results.length === 0
          ? `No notes matched "${query}".`
          : results.map((r) => `- ${r.title} [${r.kind}] (${r.path})\n    ${r.snippet}`).join("\n");
      return { content: [{ type: "text", text }], structuredContent: { results } };
    },
  );

  server.registerTool(
    "read",
    {
      title: "Read a note",
      description:
        "Read one note by its repo-relative path (as returned by search), yielding its " +
        "validated frontmatter and markdown body.",
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe("Repo-relative note path, e.g. memory/2026-07-01-foo-a1b2.md"),
      },
    },
    async ({ path }) => {
      if (brainDir === null) return noBrainConfigured();
      const note = await readNoteTool(brainDir, { path });
      const text = `# ${note.frontmatter.title}\n\n${note.body}`;
      return {
        content: [{ type: "text", text }],
        structuredContent: { path: note.path, frontmatter: note.frontmatter, body: note.body },
      };
    },
  );

  server.registerTool(
    "remember",
    {
      title: "Remember a note",
      description:
        "Write a new atomic note to the brain (memory, decision, work-state, or person) " +
        "and refresh the derived index so it is immediately searchable. M1 writes to canon " +
        "directly; later milestones route this through staging + curation.",
      inputSchema: {
        kind: kindEnum.describe("Which kind of note to create"),
        title: z.string().min(1).describe("Short title / the fact in one line"),
        body: z.string().describe("Markdown body of the note"),
        tags: z.array(z.string()).optional().describe("Topical tags"),
        author: z.string().optional().describe("Who is recording this"),
      },
    },
    async ({ kind, title, body, tags, author }) => {
      if (brainDir === null) return noBrainConfigured();
      const result = await remember(brainDir, { kind, title, body, tags, author });
      const text = `Remembered "${title}" as ${result.id} (${result.path}).`;
      return {
        content: [{ type: "text", text }],
        structuredContent: { id: result.id, path: result.path },
      };
    },
  );

  server.registerTool(
    "list-work-state",
    {
      title: "List active work-state",
      description:
        "List active work-state notes (everything not marked done) — what workstreams are " +
        "currently planned, in progress, or blocked.",
      inputSchema: {},
    },
    async () => {
      if (brainDir === null) return noBrainConfigured();
      const notes = await listWorkState(brainDir);
      const text =
        notes.length === 0 ? "No active work-state." : notes.map(summarizeNote).join("\n");
      return { content: [{ type: "text", text }], structuredContent: { notes } };
    },
  );

  server.registerTool(
    "who-is",
    {
      title: "Look up a person",
      description:
        "Find people notes by name, id, or tag (case-insensitive). Returns the matching " +
        "person threads from the brain.",
      inputSchema: {
        query: z.string().min(1).describe("Name, id, or tag to look up"),
      },
    },
    async ({ query }) => {
      if (brainDir === null) return noBrainConfigured();
      const notes = await whoIs(brainDir, { query });
      const text =
        notes.length === 0 ? `No people matched "${query}".` : notes.map(summarizeNote).join("\n");
      return { content: [{ type: "text", text }], structuredContent: { notes } };
    },
  );

  return server;
}
