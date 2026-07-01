import { type Note, type NoteKind } from "./schema.js";

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

/**
 * Parse a raw markdown-with-frontmatter string into a validated {@link Note}.
 * Throws (zod) if the frontmatter does not satisfy the schema for its `kind`.
 *
 * @param raw  full file contents (frontmatter + body)
 * @param path repo-relative path, stored on the returned note
 */
export function parseNote(_raw: string, _path: string): Note {
  throw new Error("not implemented: parseNote");
}

/** Serialize a {@link Note} back to canonical `---`-fenced frontmatter + body. */
export function serializeNote(_note: Note): string {
  throw new Error("not implemented: serializeNote");
}

/**
 * Create a new note atomically under `brainDir`. Builds the id via
 * `makeNoteId(title, created)`, writes to `pathForNote(kind, id)` using a
 * write-to-temp-then-rename so readers never see a partial file, and returns the
 * parsed note. Because ids embed a random suffix, concurrent writers never collide.
 */
export async function writeNote(_brainDir: string, _input: NewNoteInput): Promise<Note> {
  throw new Error("not implemented: writeNote");
}

/** Read and parse a single note by its repo-relative path. */
export async function readNote(_brainDir: string, _relPath: string): Promise<Note> {
  throw new Error("not implemented: readNote");
}

/** List all notes, optionally filtered to one kind. */
export async function listNotes(_brainDir: string, _kind?: NoteKind): Promise<Note[]> {
  throw new Error("not implemented: listNotes");
}
