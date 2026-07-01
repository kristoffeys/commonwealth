import { type Note } from "@commons/core";

/** Heading that prefaces injected team-brain context. */
const CONTEXT_HEADING = "## Relevant from the team brain";

/** First non-empty line of a note body, used as a compact snippet. */
function firstLine(body: string): string {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

/**
 * Render selected notes as compact markdown suitable for injection into a Claude Code
 * session (e.g. by a SessionStart hook). Emits a heading followed by one bullet per note:
 * `- **<title>** (<kind>) — <snippet>`. Returns "" for an empty selection so a hook can
 * inject nothing.
 */
export function formatContext(notes: Note[]): string {
  if (notes.length === 0) return "";
  const lines = [CONTEXT_HEADING, ""];
  for (const note of notes) {
    const { title, kind } = note.frontmatter;
    const snippet = firstLine(note.body);
    lines.push(snippet ? `- **${title}** (${kind}) — ${snippet}` : `- **${title}** (${kind})`);
  }
  return lines.join("\n");
}
