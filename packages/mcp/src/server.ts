import path from "node:path";
import { NOTE_KINDS, type Note, type NoteKind } from "@cmnwlth/core";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PROMPTS, promptArgsSchema } from "./prompts.js";
import {
  listBrainResources,
  readKindIndexResource,
  readMapResource,
  readNoteResource,
  RESOURCE_SCHEME,
} from "./resources.js";
import {
  askBrainTool,
  listWorkState,
  readNoteTool,
  remember,
  searchNotes,
  whoIs,
} from "./tools.js";

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
 * Why no brain is available, when {@link createServer} is built with `null`. `none` = nothing maps
 * (run `init`); `corrupt-config` = the per-user config file exists but doesn't parse (a hand-edit
 * typo, #210) — a fundamentally different failure whose fix is "repair the file", NOT re-onboarding.
 */
export type BrainUnavailable =
  { kind: "none" } | { kind: "corrupt-config"; path: string; error: string };

/** Wrap human text as the MCP error-result shape. */
function toolError(text: string): ToolError {
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * The explicit "brain unavailable" result. Returned by every tool when the server was built
 * without a resolved brain (see {@link createServer}), instead of silently operating on the process
 * cwd. For `none` it tells the user how to wire one up (#64); for `corrupt-config` it names the
 * broken file and the parse error and says to fix or restore it — the misleading "run
 * `commonwealth init`" would send the user re-onboarding instead of fixing the one-char typo that
 * disabled everything (#210).
 */
function brainUnavailable(reason: BrainUnavailable): ToolError {
  if (reason.kind === "corrupt-config") {
    return toolError(
      `Commonwealth's config file at ${reason.path} is unparseable: ${reason.error}. No brain ` +
        `could be resolved, so capture and recall are OFF until it is fixed. Repair the JSON (a ` +
        `stray trailing comma is the usual cause) or restore it from a \`.corrupt-<ts>\` backup, ` +
        `then retry. Run \`commonwealth doctor\` to confirm.`,
    );
  }
  const cwd = process.cwd();
  return toolError(
    `No Commonwealth brain is configured for ${cwd}. Run \`commonwealth init\` here to ` +
      `create or join a brain, or add a prefix → brain mapping to ` +
      `~/.commonwealth/config.json. (Set COMMONWEALTH_BRAIN_DIR to pin one explicitly.)`,
  );
}

/**
 * Build the Commonwealth MCP server with its tools wired to the pure handlers in
 * `tools.ts`. Every tool reads/writes the brain only through `@cmnwlth/core`, keeping
 * markdown the source of truth (ADR-0003).
 *
 * @param brainDir Absolute path to the brain repo, or `null` when resolution found no brain for the
 *   cwd. When `null` the server still starts (so the plugin never breaks an unmapped project) but
 *   every tool returns {@link brainUnavailable} rather than silently reading/writing the cwd.
 *   Defaults to the process cwd when omitted so a caller that already `cd`'d into a brain can build
 *   the server without resolving.
 * @param unavailable Why no brain is available, used to shape the error when `brainDir` is `null`:
 *   `none` (nothing maps) vs `corrupt-config` (the config file is broken, #210). Ignored when a
 *   brain resolved.
 * @param brainName Human-readable brain name used in resource URIs (`commonwealth://<name>/…`,
 *   #217). Defaults to the brain directory's basename (which is also the scaffold's default config
 *   name); `index.ts` passes the real configured name. Ignored when `brainDir` is `null`.
 */
export function createServer(
  brainDir: string | null = process.cwd(),
  unavailable: BrainUnavailable = { kind: "none" },
  brainName: string = brainDir ? path.basename(brainDir) : "commonwealth",
): McpServer {
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
      if (brainDir === null) return brainUnavailable(unavailable);
      const results = await searchNotes(brainDir, { query, kind, limit });
      const text =
        results.length === 0
          ? `No notes matched "${query}".`
          : results.map((r) => `- ${r.title} [${r.kind}] (${r.path})\n    ${r.snippet}`).join("\n");
      return { content: [{ type: "text", text }], structuredContent: { results } };
    },
  );

  server.registerTool(
    "ask",
    {
      title: "Ask the brain",
      description:
        "Answer a natural-language question from the team brain with FAITHFUL CITATIONS. This " +
        "tool retrieves the most relevant notes and returns them as citation-anchored context — it " +
        "does NOT write the answer; YOU do, from these notes only. Rules: (1) answer ONLY from the " +
        "returned notes; (2) cite every claim with its note id and path; (3) if `coverage.matched` " +
        "is false or the notes don't actually address the question, say you don't have enough in " +
        "the brain to answer — never invent facts or citations. Use `read` to pull a full note when " +
        "an excerpt is not enough.",
      inputSchema: {
        question: z.string().min(1).describe("The natural-language question to answer"),
        limit: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe("Max notes to retrieve (default 8)"),
      },
    },
    async ({ question, limit }) => {
      if (brainDir === null) return brainUnavailable(unavailable);
      const result = await askBrainTool(brainDir, { question, limit });
      const text = !result.coverage.matched
        ? `No notes in the brain matched "${question}". Tell the user you don't have enough to answer.`
        : `Answer "${question}" using ONLY these notes, citing each by id/path; if they don't cover it, say so:\n\n` +
          result.hits
            .map((h) => `- [${h.kind}] ${h.title} (id: ${h.id}, path: ${h.path})\n    ${h.excerpt}`)
            .join("\n");
      return { content: [{ type: "text", text }], structuredContent: { ...result } };
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
      if (brainDir === null) return brainUnavailable(unavailable);
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
        "Record a new atomic note in the brain (memory, decision, work-state, or person). It " +
        "goes through the same curation as automatic capture — the secret gate, dedup, and the " +
        "brain's autoPromote setting — so it lands in canon (autoPromote on) or the review queue " +
        "(off), and may be declined (e.g. a secret or a near-duplicate). The contributor is " +
        "created as a person when needed and linked to the note for responsibility tracing.",
      inputSchema: {
        kind: kindEnum.describe("Which kind of note to create"),
        title: z.string().min(1).describe("Short title / the fact in one line"),
        body: z.string().describe("Markdown body of the note"),
        tags: z.array(z.string()).optional().describe("Topical tags"),
        author: z
          .string()
          .optional()
          .describe("Deprecated compatibility field; ignored for responsibility attribution"),
      },
    },
    async ({ kind, title, body, tags, author }) => {
      if (brainDir === null) return brainUnavailable(unavailable);
      const result = await remember(brainDir, { kind, title, body, tags, author });
      // A promoted note lands in canon, so it becomes a new resource — tell subscribed clients to
      // refresh their listing (#217). In-process trigger only; cross-process sync-driven changes
      // (a teammate's note arriving via `git pull`) are a follow-up (they need a filesystem watcher).
      if (result.status === "promoted") server.sendResourceListChanged();
      const text =
        result.status === "promoted"
          ? `Remembered "${title}" as ${result.id} (${result.path}).`
          : result.status === "staged"
            ? `Staged "${title}" for review as ${result.id} (${result.path}); approve with /commonwealth:promote.`
            : `Did not remember "${title}": ${result.reason}.`;
      return {
        content: [{ type: "text", text }],
        structuredContent: { ...result },
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
      if (brainDir === null) return brainUnavailable(unavailable);
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
      if (brainDir === null) return brainUnavailable(unavailable);
      const notes = await whoIs(brainDir, { query });
      const text =
        notes.length === 0 ? `No people matched "${query}".` : notes.map(summarizeNote).join("\n");
      return { content: [{ type: "text", text }], structuredContent: { notes } };
    },
  );

  // --- Prompts (#216) ---------------------------------------------------------------------------
  // Expose the command set (`ask`/`recall`/`remember`/`decide`/`status`/`promote`) as MCP prompts,
  // so every MCP client — not just the Claude Code plugin — gets Commonwealth's verbs. Definitions
  // are ported (single-source) from packages/plugin/commands/*.md; see prompts.ts. They're static,
  // so we don't emit notifications/prompts/list_changed; registering them advertises the `prompts`
  // capability. Prompts are just instruction text (they don't touch the brain), so we register them
  // even when no brain is resolved — the tools they invoke report the "no brain" error themselves.
  for (const def of PROMPTS) {
    // Omit argsSchema entirely for a no-argument prompt: an empty zod object shape makes the SDK
    // require an (empty) arguments object, so `prompts/get` with no arguments fails validation.
    const argsSchema = def.args.length > 0 ? promptArgsSchema(def) : undefined;
    server.registerPrompt(
      def.name,
      { title: def.title, description: def.description, ...(argsSchema ? { argsSchema } : {}) },
      (args: Record<string, string | undefined>) => ({
        messages: [{ role: "user", content: { type: "text", text: def.render(args) } }],
      }),
    );
  }

  // --- Resources (#217) -------------------------------------------------------------------------
  // Read-only browse/@-mention surface: the map, per-kind indexes, and individual notes. Only when
  // a brain resolved (no brain → no resources to serve; the tools already explain why). Read
  // semantics mirror the `read` tool exactly (canon only, superseded marked); see resources.ts.
  if (brainDir !== null) {
    const dir = brainDir;

    // The brain map + the per-kind indexes share a one-path-segment shape
    // (commonwealth://<brain>/COMMONWEALTH.md and commonwealth://<brain>/<kind>). One template
    // enumerates and serves both; the note template below handles the two-segment note URIs.
    // Number of path segments after `commonwealth://<brain>/`: 1 for map/index URIs, 2 for notes.
    const authority = `${RESOURCE_SCHEME}://${brainName}/`;
    const pathDepth = (uri: string): number => uri.slice(authority.length).split("/").length;

    const kindSet = new Set<string>(NOTE_KINDS);
    server.registerResource(
      "commonwealth-overview",
      new ResourceTemplate(`${RESOURCE_SCHEME}://${brainName}/{segment}`, {
        list: async () => {
          const all = await listBrainResources(dir, brainName);
          return { resources: all.filter((r) => pathDepth(r.uri) === 1) };
        },
      }),
      { description: "The brain map (COMMONWEALTH.md) and per-kind indexes." },
      async (uri, { segment }) => {
        const seg = String(segment);
        if (seg === "COMMONWEALTH.md") {
          return {
            contents: [
              { uri: uri.href, mimeType: "text/markdown", text: await readMapResource(dir) },
            ],
          };
        }
        if (kindSet.has(seg)) {
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: "text/markdown",
                text: await readKindIndexResource(dir, seg as NoteKind),
              },
            ],
          };
        }
        throw new Error(`Unknown resource: ${uri.href}`);
      },
    );

    // Individual notes (+ the "…N more" sentinel), all two-segment URIs: <brain>/<kind>/<id>.
    server.registerResource(
      "commonwealth-note",
      new ResourceTemplate(`${RESOURCE_SCHEME}://${brainName}/{kind}/{id}`, {
        list: async () => {
          const all = await listBrainResources(dir, brainName);
          return { resources: all.filter((r) => pathDepth(r.uri) === 2) };
        },
      }),
      { description: "Individual canon notes (superseded ones are readable but marked)." },
      async (uri, { kind, id }) => {
        const k = String(kind);
        const noteId = String(id);
        if (k === "_more") {
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: "text/markdown",
                text:
                  "More notes than the list cap exposes. Use the `search` tool or a per-kind " +
                  "index resource to reach the rest — nothing is hidden, just not enumerated.",
              },
            ],
          };
        }
        const text = await readNoteResource(dir, k, noteId);
        if (text === null) throw new Error(`No canon note ${k}/${noteId} in this brain.`);
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
      },
    );
  }

  return server;
}
