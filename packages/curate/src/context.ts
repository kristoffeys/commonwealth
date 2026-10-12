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

/** One compact entry in {@link formatCompactContext} — the extraction prompt's "existing notes" hint. */
export interface CompactNote {
  id: string;
  title: string;
  kind: Note["frontmatter"]["kind"];
}

/**
 * Render selected notes as the compact `{ id, title, kind }` shape consumed by the extraction
 * prompt's "existing notes" hint (#317) — deliberately NOT the markdown injection format, since
 * that carries a body snippet the prompt doesn't need and would only cost byte budget.
 */
export function formatCompactContext(notes: Note[]): CompactNote[] {
  return notes.map((note) => ({
    id: note.frontmatter.id,
    title: note.frontmatter.title,
    kind: note.frontmatter.kind,
  }));
}
