import { type Note } from "@cmnwlth/core";

/** Max length of a body snippet before it is truncated. */
const SNIPPET_MAX = 120;

/** First non-empty line of a note body, used as a compact snippet. */
function firstLine(body: string): string {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed.length > SNIPPET_MAX ? trimmed.slice(0, SNIPPET_MAX) : trimmed;
    }
  }
  return "";
}

/**
 * Render selected notes as compact markdown suitable for injection into a Claude Code
 * session (e.g. by a SessionStart hook). The FIRST LINE is a heading that encodes the note
 * count so a value receipt can parse it (`## Team brain — N relevant note(s)`), followed by
 * a citation hint and one bullet per note: `- **<title>** (<kind>) — <snippet>`. Returns ""
 * for an empty selection so a hook can inject nothing. Pure function.
 *
 * @param notes  The selected notes to render.
 * @returns      Markdown context, or "" when `notes` is empty.
 */
export function formatContext(notes: Note[]): string {
  if (notes.length === 0) return "";
  const lines = [
    `## Team brain — ${notes.length} relevant note(s)`,
    '_Cite any note you use inline, e.g. "📖 from the team brain: TITLE"._',
    "",
  ];
  for (const note of notes) {
    const { title, kind } = note.frontmatter;
    const snippet = firstLine(note.body);
    lines.push(snippet ? `- **${title}** (${kind}) — ${snippet}` : `- **${title}** (${kind})`);
  }
  return lines.join("\n");
}
