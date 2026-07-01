import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { makeNoteId, pathForNote, shortId, today } from "./ids.js";
import { Frontmatter, KIND_DIR, NOTE_KINDS, type Note, type NoteKind } from "./schema.js";

/**
 * Input to create a new note. `id`, `created` (defaults to today), and the file path are
 * derived; kind-specific fields (e.g. a decision's `deciders`) go in `fields` and are
 * validated against the schema.
 */
export interface NewNoteInput {
  kind: NoteKind;
  title: string;
  body: string;
  tags?: string[];
  author?: string;
  /** `YYYY-MM-DD`; defaults to today. */
  created?: string;
  /** Extra kind-specific frontmatter fields, validated against the schema. */
  fields?: Record<string, unknown>;
}

/** Preferred frontmatter key order for stable, readable, diff-friendly output. */
const KEY_ORDER = [
  "id",
  "kind",
  "title",
  "name",
  "org",
  "role",
  "owner",
  "status",
  "tags",
  "created",
  "updated",
  "author",
  "verified",
  "deciders",
  "supersedes",
  "superseded_by",
  "sources",
  "relates",
];

function orderFrontmatter(fm: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of KEY_ORDER) {
    if (key in fm && fm[key] !== undefined) out[key] = fm[key];
  }
  // Preserve any unknown keys the schema let through, appended in stable order.
  for (const key of Object.keys(fm).sort()) {
    if (!(key in out) && fm[key] !== undefined) out[key] = fm[key];
  }
  return out;
}

/**
 * Parse a raw markdown-with-frontmatter string into a validated {@link Note}.
 * Throws (zod) if the frontmatter does not satisfy the schema for its `kind`.
 */
export function parseNote(raw: string, notePath: string): Note {
  const parsed = matter(raw);
  const frontmatter = Frontmatter.parse(parsed.data);
  return { frontmatter, body: parsed.content.trim(), path: notePath };
}

/** Serialize a {@link Note} back to canonical `---`-fenced frontmatter + body. */
export function serializeNote(note: Note): string {
  const ordered = orderFrontmatter(note.frontmatter as unknown as Record<string, unknown>);
  const body = note.body.trim();
  return matter.stringify(body ? `${body}\n` : "", ordered);
}

/**
 * Create a new note atomically under `brainDir`. The id embeds a random suffix
 * (`makeNoteId`), so two concurrent writers of the same title+date produce distinct
 * files that git unions rather than conflicts (ADR-0003). Writes to a temp file then
 * renames, so readers never observe a partial file.
 */
export async function writeNote(brainDir: string, input: NewNoteInput): Promise<Note> {
  const created = input.created ?? today();
  const id = makeNoteId(input.title, created);
  const relPath = pathForNote(input.kind, id);
  const absPath = path.join(brainDir, relPath);

  const raw: Record<string, unknown> = {
    id,
    kind: input.kind,
    title: input.title,
    tags: input.tags ?? [],
    created,
    ...(input.author ? { author: input.author } : {}),
    ...(input.fields ?? {}),
  };
  const frontmatter = Frontmatter.parse(raw);
  const note: Note = { frontmatter, body: input.body.trim(), path: relPath };
  const content = serializeNote(note);

  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.${shortId()}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, absPath);
  return note;
}

/** Read and parse a single note by its repo-relative path. */
export async function readNote(brainDir: string, relPath: string): Promise<Note> {
  const raw = await fs.readFile(path.join(brainDir, relPath), "utf8");
  return parseNote(raw, relPath);
}

/** List all notes, optionally filtered to one kind. Skips generated `INDEX.md`. */
export async function listNotes(brainDir: string, kind?: NoteKind): Promise<Note[]> {
  const kinds: readonly NoteKind[] = kind ? [kind] : NOTE_KINDS;
  const notes: Note[] = [];
  for (const k of kinds) {
    const dir = path.join(brainDir, KIND_DIR[k]);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue; // folder may not exist yet
    }
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".md") || entry === "INDEX.md") continue;
      notes.push(await readNote(brainDir, `${KIND_DIR[k]}/${entry}`));
    }
  }
  return notes;
}
