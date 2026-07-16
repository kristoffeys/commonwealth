import { promises as fs } from "node:fs";
import path from "node:path";
import { NOTE_KINDS, listNotes, readNote, type Note, type NoteKind } from "@cmnwlth/core";

/**
 * Read-only MCP resources for a Commonwealth brain (#217): the `COMMONWEALTH.md` map, a per-kind
 * index, and every canon note — so a client can BROWSE the brain and @-mention a specific note to
 * pin it into context, instead of only reaching notes through search/read round-trips.
 *
 * READ SEMANTICS mirror the `read` tool exactly (ADR-0003: markdown is the source of truth): notes
 * are read straight off disk through `@cmnwlth/core`, no parallel store, no new data path. Canon
 * only — `listNotes` already skips `staging/` and derived `index/`, so staged (unpromoted) notes
 * are never exposed. Superseded notes ARE listed and readable (git keeps history; superseding keeps
 * the reasoning visible — CLAUDE.md principle 3) but are clearly MARKED so a reader isn't misled.
 *
 * CAP: `resources/list` returns at most {@link RESOURCE_LIST_CAP} notes — the most-recently-created
 * ones — plus the map and the kind indexes. When the brain has more, the list includes an explicit
 * {@link moreResourceUri} sentinel ("N more … use search") so truncation is never silent; the full
 * set stays reachable via the `search` tool and the per-kind indexes.
 */

/** Max notes enumerated in `resources/list` (most-recent first). The map + indexes are extra. */
export const RESOURCE_LIST_CAP = 200;

/** URI scheme for brain resources. */
export const RESOURCE_SCHEME = "commonwealth";

/** MIME type for every resource we serve (markdown). */
const MARKDOWN = "text/markdown";

/** `commonwealth://<brain>/COMMONWEALTH.md` — the brain map. */
export function mapResourceUri(brain: string): string {
  return `${RESOURCE_SCHEME}://${brain}/COMMONWEALTH.md`;
}

/** `commonwealth://<brain>/<kind>` — the index of one note kind. */
export function kindIndexUri(brain: string, kind: NoteKind): string {
  return `${RESOURCE_SCHEME}://${brain}/${kind}`;
}

/** `commonwealth://<brain>/<kind>/<id>` — a single note. */
export function noteResourceUri(brain: string, kind: string, id: string): string {
  return `${RESOURCE_SCHEME}://${brain}/${kind}/${id}`;
}

/**
 * Sentinel URI listed when the note count exceeds the cap. Routed as `kind="_more"`, `id="notes"`
 * so it matches the same `{kind}/{id}` resource template as real notes (`_more` is not a real note
 * kind, so it can never collide with one).
 */
export function moreResourceUri(brain: string): string {
  return `${RESOURCE_SCHEME}://${brain}/_more/notes`;
}

/** True when a note is superseded (memory/decision carry this status). */
export function isSuperseded(note: Note): boolean {
  const fm = note.frontmatter;
  return "status" in fm && fm.status === "superseded";
}

/** A resource entry as returned in `resources/list`. */
export interface ResourceListing {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
}

/** Comparable timestamp for "most-recent" ordering; falls back to the empty string. */
function createdKey(note: Note): string {
  const fm = note.frontmatter as { created?: string };
  return fm.created ?? "";
}

/**
 * Build the full `resources/list`: the map, one index per kind, the most-recent notes (capped at
 * {@link RESOURCE_LIST_CAP}), and — only when the cap truncated the set — a `…N more` sentinel.
 * Notes are sorted most-recent-first so the cap keeps the freshest knowledge visible.
 */
export async function listBrainResources(
  brainDir: string,
  brain: string,
): Promise<ResourceListing[]> {
  const listings: ResourceListing[] = [
    {
      uri: mapResourceUri(brain),
      name: "COMMONWEALTH.md",
      title: `${brain} — brain map`,
      description: "The generated brain-at-a-glance map (COMMONWEALTH.md).",
      mimeType: MARKDOWN,
    },
  ];

  const all = await listNotes(brainDir);
  for (const kind of NOTE_KINDS) {
    const count = all.filter((n) => n.frontmatter.kind === kind).length;
    listings.push({
      uri: kindIndexUri(brain, kind),
      name: `${kind}/`,
      title: `${brain} — ${kind} index`,
      description: `Index of ${count} ${kind} note(s).`,
      mimeType: MARKDOWN,
    });
  }

  const sorted = [...all].sort((a, b) => {
    const byDate = createdKey(b).localeCompare(createdKey(a));
    return byDate !== 0 ? byDate : b.frontmatter.id.localeCompare(a.frontmatter.id);
  });
  const capped = sorted.slice(0, RESOURCE_LIST_CAP);
  for (const note of capped) {
    const fm = note.frontmatter;
    const supersededTag = isSuperseded(note) ? " [superseded]" : "";
    listings.push({
      uri: noteResourceUri(brain, fm.kind, fm.id),
      name: fm.id,
      title: fm.title,
      description: `${fm.kind}${supersededTag} — ${note.path}`,
      mimeType: MARKDOWN,
    });
  }

  const remaining = sorted.length - capped.length;
  if (remaining > 0) {
    listings.push({
      uri: moreResourceUri(brain),
      name: "_more",
      title: `…${remaining} more note(s) not listed`,
      description:
        `${remaining} older note(s) exceed the ${RESOURCE_LIST_CAP}-resource list cap. Use the ` +
        `\`search\` tool (or a per-kind index) to reach them — nothing is hidden, just not listed.`,
      mimeType: MARKDOWN,
    });
  }

  return listings;
}

/** Read the `COMMONWEALTH.md` map. Returns an empty-map note if it hasn't been generated yet. */
export async function readMapResource(brainDir: string): Promise<string> {
  try {
    return await fs.readFile(path.join(brainDir, "COMMONWEALTH.md"), "utf8");
  } catch {
    return "# COMMONWEALTH\n\n(The brain map has not been generated yet.)\n";
  }
}

/** Render the markdown index for one kind: a bulleted list of its notes (superseded ones marked). */
export async function readKindIndexResource(brainDir: string, kind: NoteKind): Promise<string> {
  const notes = (await listNotes(brainDir, kind)).sort((a, b) => {
    const byDate = createdKey(b).localeCompare(createdKey(a));
    return byDate !== 0 ? byDate : b.frontmatter.id.localeCompare(a.frontmatter.id);
  });
  const header = `# ${kind} — ${notes.length} note(s)\n`;
  if (notes.length === 0) return `${header}\n(none yet)\n`;
  const lines = notes.map((n) => {
    const mark = isSuperseded(n) ? " _(superseded)_" : "";
    return `- **${n.frontmatter.title}**${mark} — \`${n.frontmatter.id}\` (${n.path})`;
  });
  return `${header}\n${lines.join("\n")}\n`;
}

/**
 * Read one note by `(kind, id)`, mirroring the `read` tool's output (`# title` + body). A
 * superseded note is prefixed with a clear marker (and, when known, what superseded it) so a reader
 * pinning it into context is never misled — the content is otherwise unchanged. Returns `null` when
 * no canon note matches, so the caller can surface a proper not-found error.
 */
export async function readNoteResource(
  brainDir: string,
  kind: string,
  id: string,
): Promise<string | null> {
  const notes = await listNotes(brainDir, kind as NoteKind);
  const match = notes.find((n) => n.frontmatter.id === id && n.frontmatter.kind === kind);
  if (!match) return null;
  const note = await readNote(brainDir, match.path);
  const fm = note.frontmatter;
  let banner = "";
  if (isSuperseded(note)) {
    const by =
      "superseded_by" in fm && fm.superseded_by ? ` by \`${fm.superseded_by}\`` : "";
    banner = `> ⚠️ **Superseded**${by} — kept for history; prefer the note that replaced it.\n\n`;
  }
  return `${banner}# ${fm.title}\n\n${note.body}`;
}
