import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { makeNoteId, pathForNote, shortId, today } from "./ids.js";
import { Frontmatter, KIND_DIR, type Note, type NoteKind } from "./schema.js";

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
  /** Originating project (git repo identity); recorded as frontmatter `source` (ADR-0015). */
  source?: string;
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
  "source",
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

/**
 * Resolve `relPath` under `brainDir` and assert it stays inside the brain (path containment).
 * A `relPath` containing `../` — from a malicious MCP `read` arg or an attacker-controlled note
 * id — would otherwise escape the brain and read/write arbitrary files (#76, #77). Boundary-safe:
 * `/brain` does not contain `/brainiac`. Returns the resolved absolute path.
 */
export function resolveWithinBrain(brainDir: string, relPath: string): string {
  const base = path.resolve(brainDir);
  const abs = path.resolve(base, relPath);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error(`Path escapes the brain directory: ${relPath}`);
  }
  return abs;
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
  const relPath = pathForNote(input.kind, id, input.source);
  const absPath = resolveWithinBrain(brainDir, relPath);

  // Spread caller `fields` FIRST so the derived, trusted keys below always win. Otherwise a
  // candidate carrying `fields: { id: "../../evil" }` would override the safe derived id and
  // desync frontmatter.id from the filename — the injection point behind #77.
  const raw: Record<string, unknown> = {
    ...(input.fields ?? {}),
    id,
    kind: input.kind,
    title: input.title,
    tags: input.tags ?? [],
    created,
    ...(input.author ? { author: input.author } : {}),
    ...(input.source ? { source: input.source } : {}),
  };
  const frontmatter = Frontmatter.parse(raw);
  const note: Note = { frontmatter, body: input.body.trim(), path: relPath };
  const content = serializeNote(note);

  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.${shortId()}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  // Publish via link+unlink rather than rename so an id collision fails CLOSED: `fs.link`
  // throws EEXIST if the note path already exists, whereas `fs.rename` would silently
  // overwrite the existing note (#101). makeNoteId's random suffix makes a real collision
  // astronomically rare, but "never silently overwrite" is a core invariant (ADR-0003).
  try {
    await fs.link(tmp, absPath);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Refusing to overwrite an existing note at ${relPath} (id collision)`);
    }
    throw err;
  }
  await fs.rm(tmp, { force: true });
  return note;
}

/** Read and parse a single note by its repo-relative path. */
export async function readNote(brainDir: string, relPath: string): Promise<Note> {
  const raw = await fs.readFile(resolveWithinBrain(brainDir, relPath), "utf8");
  return parseNote(raw, relPath);
}

/** Folder names that hold notes (the values of {@link KIND_DIR}); a note's parent dir. */
const KIND_FOLDERS = new Set<string>(Object.values(KIND_DIR));

/** Top-level dirs that never contain notes and must not be walked (derived/local/vcs). */
const NON_NOTE_DIRS = new Set([".git", ".commonwealth", "index", "staging", "node_modules"]);

/**
 * List all notes, optionally filtered to one kind. Layout-agnostic (ADR-0015): notes may live
 * at the kind root (`<kind>/<id>.md`, unattributed) or under a per-project subtree
 * (`<project>/<kind>/<id>.md`). A file is a note when its PARENT folder is a kind folder and it
 * is not the generated `INDEX.md`; the authoritative kind comes from frontmatter. Skips derived
 * (`index/`), local (`staging/`), and vcs dirs so canon never includes staged/derived files.
 */
export async function listNotes(brainDir: string, kind?: NoteKind): Promise<Note[]> {
  const found: string[] = [];

  async function walk(absDir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return; // dir may not exist yet
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (NON_NOTE_DIRS.has(entry.name)) continue;
        await walk(path.join(absDir, entry.name));
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".md") &&
        entry.name !== "INDEX.md" &&
        KIND_FOLDERS.has(path.basename(absDir))
      ) {
        found.push(path.relative(brainDir, path.join(absDir, entry.name)));
      }
    }
  }

  await walk(brainDir);

  const notes: Note[] = [];
  for (const rel of found.sort()) {
    const note = await readNote(brainDir, rel);
    if (!kind || note.frontmatter.kind === kind) notes.push(note);
  }
  return notes;
}
