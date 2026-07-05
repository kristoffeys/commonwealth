import { listNotes } from "./notes.js";
import type { Note } from "./schema.js";

/**
 * Derived agent-context emitter (#135). Cursor/Codex/Copilot teammates can't run the Commonwealth
 * MCP server, but they *do* honor generated context files in the repo. This renders a project's
 * canon slice (ADR-0015 provenance) into one plain-markdown block those tools read — the cheap,
 * read-only forerunner of a cross-agent MCP adapter. It's ADR-0003's "regenerated, never
 * hand-merged" derived-file pattern pointed outward.
 *
 * The rendered block is a pure, DETERMINISTIC function of the note set — no timestamp, no ordering
 * nondeterminism — so a committed `AGENTS.md` sentinel block never churns across teammates'
 * machines. The CLI wraps this block in each tool's file format and stamps time only into the
 * wholly-owned, gitignored files.
 */

/** Sentinel-fenced block name (used by the AGENTS.md managed block in the CLI writer). */
export const EMIT_BEGIN =
  "<!-- BEGIN COMMONWEALTH (generated — do not edit; run `commonwealth emit`) -->";
export const EMIT_END = "<!-- END COMMONWEALTH -->";

/** Options for {@link renderAgentContext}. */
export interface RenderContextOptions {
  /** Project identity to slice on (a note's frontmatter `source`, per {@link resolveProjectSource}). */
  projectSource: string;
  /** Approximate character budget for the rendered block (~4 chars/token). Default 8000. */
  maxChars?: number;
}

/** A note is superseded (archaeology) if it points forward or is explicitly marked. Mirrors #133. */
function isSuperseded(note: Note): boolean {
  const fm = note.frontmatter;
  if ((fm.kind === "memory" || fm.kind === "decision") && typeof fm.superseded_by === "string") {
    return fm.superseded_by.length > 0;
  }
  return "status" in fm && fm.status === "superseded";
}

/** First non-empty line of a body, whitespace-collapsed and capped — a one-line gist. */
function gist(body: string, max = 160): string {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#"));
  if (!line) return "";
  const clean = line.replace(/\s+/g, " ");
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function byId(a: Note, b: Note): number {
  return a.frontmatter.id < b.frontmatter.id ? -1 : a.frontmatter.id > b.frontmatter.id ? 1 : 0;
}
function byCreatedDesc(a: Note, b: Note): number {
  if (a.frontmatter.created !== b.frontmatter.created) {
    return a.frontmatter.created < b.frontmatter.created ? 1 : -1;
  }
  return byId(a, b);
}

/**
 * Render the canon slice for `projectSource` as an agent-readable markdown block: recent decisions,
 * active work-state, and key memories, each as a titled one-line gist. Canon only — superseded
 * notes are excluded (#133). Deterministic and budget-bounded: sections are filled decisions →
 * work-state → memories until `maxChars` is reached, so the most decision-relevant context survives
 * truncation. Returns an empty-state block when the project has no canon.
 */
export function renderAgentContext(notes: Note[], opts: RenderContextOptions): string {
  const maxChars = opts.maxChars ?? 8000;
  const slice = notes.filter(
    (n) => (n.frontmatter.source ?? "") === opts.projectSource && !isSuperseded(n),
  );

  const header = [
    "# Team brain (Commonwealth)",
    "",
    `Shared team knowledge for **${opts.projectSource}**, generated from the team's Commonwealth`,
    "brain. Read this before acting; treat it as authoritative team context. Do not edit — it is",
    "regenerated from canonical notes (run `commonwealth emit`).",
    "",
  ].join("\n");

  if (slice.length === 0) {
    return `${header}\n_No canonical notes for this project yet._\n`;
  }

  const decisions = slice.filter((n) => n.frontmatter.kind === "decision").sort(byCreatedDesc);
  const work = slice
    .filter((n) => n.frontmatter.kind === "work-state" && n.frontmatter.status !== "done")
    .sort(byId);
  const memories = slice.filter((n) => n.frontmatter.kind === "memory").sort(byId);

  const lines: string[] = [header];
  let used = header.length;
  /** Append a section, stopping items once the budget is hit; drop the section if it gets nothing. */
  const section = (title: string, items: Note[], fmt: (n: Note) => string): void => {
    if (items.length === 0) return;
    const entries: string[] = [];
    for (const n of items) {
      const entry = fmt(n);
      if (used + entry.length + 1 > maxChars && entries.length > 0) break;
      entries.push(entry);
      used += entry.length + 1;
    }
    if (entries.length === 0) return;
    lines.push(`## ${title}`, "", ...entries, "");
    used += title.length + 4;
  };

  const decisionLine = (n: Note): string => {
    const g = gist(n.body);
    return `- **${n.frontmatter.title}** (${n.frontmatter.created})${g ? ` — ${g}` : ""}`;
  };
  const workLine = (n: Note): string => {
    const status = n.frontmatter.kind === "work-state" ? n.frontmatter.status : "";
    const g = gist(n.body);
    return `- **${n.frontmatter.title}** [${status}]${g ? ` — ${g}` : ""}`;
  };
  const memoryLine = (n: Note): string => {
    const g = gist(n.body);
    return `- **${n.frontmatter.title}**${g ? ` — ${g}` : ""}`;
  };

  section("Decisions", decisions, decisionLine);
  section("Active work", work, workLine);
  section("Key facts", memories, memoryLine);

  return `${lines.join("\n")}\n`;
}

/** Load a brain's notes and render the agent-context block for one project. Read-only. */
export async function emitAgentContext(
  brainDir: string,
  opts: RenderContextOptions,
): Promise<string> {
  return renderAgentContext(await listNotes(brainDir), opts);
}
