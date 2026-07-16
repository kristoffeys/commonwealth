import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { makeNoteId, pathForNote, shortId, today } from "./ids.js";
import { Frontmatter, KIND_DIR, SafeId, type Note, type NoteKind } from "./schema.js";

/**
 * Input to create a new note. `id`, `created` (defaults to today), and the file path are
 * derived; kind-specific fields (e.g. a decision's `deciders`) go in `fields` and are
 * validated against the schema.
 */
export interface NewNoteInput {
  /** Optional trusted stable id; ordinary notes derive a collision-proof id automatically. */
  id?: string;
  kind: NoteKind;
  title: string;
  body: string;
  tags?: string[];
  author?: string;
  /** Stable contributor-person id; serialized as `author_ref`. */
  authorRef?: string;
  /** Originating project (git repo identity); recorded as frontmatter `source` (ADR-0015). */
  source?: string;
  /** `YYYY-MM-DD`; defaults to today. */
  created?: string;
  /** Extra kind-specific frontmatter fields, validated against the schema. */
  fields?: Record<string, unknown>;
}

/** Raised when a trusted deterministic note id is already present; callers may verify the winner. */
export class NoteIdCollisionError extends Error {
  constructor(path: string) {
    super(`Refusing to overwrite an existing note at ${path} (id collision)`);
    this.name = "NoteIdCollisionError";
  }
}

/** Explicit system ids use the portable subset; parsed historical ids remain backward compatible. */
function parseProvidedId(value: string): string {
  const id = SafeId.parse(value);
  const portable = /^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/.test(id);
  const windowsDevice = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(id);
  if (!portable || windowsDevice) {
    throw new Error("explicit note id must be a portable 1-120 character lowercase filename");
  }
  return id;
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
  "author_ref",
  "attribution_key",
  "email",
  "source",
  "verified",
  "deciders",
  "supersedes",
  "superseded_by",
  "contradicts",
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
 * Create a new note atomically under `brainDir`. By default the id embeds a random suffix
 * (`makeNoteId`), so two concurrent writers of the same title+date produce distinct files that
 * git unions rather than conflicts (ADR-0003). Trusted internal callers may provide a validated,
 * deterministic id for idempotent system records. Readers never observe a partial file.
 */
export async function writeNote(brainDir: string, input: NewNoteInput): Promise<Note> {
  const created = input.created ?? today();
  const id = input.id === undefined ? makeNoteId(input.title, created) : parseProvidedId(input.id);
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
    ...(input.authorRef ? { author_ref: input.authorRef } : {}),
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
      throw new NoteIdCollisionError(relPath);
    }
    throw err;
  }
  await fs.rm(tmp, { force: true });
  return note;
}

/**
 * Overwrite an existing note's file with `note` (its `path`), atomically (tmp + rename). Unlike
 * {@link writeNote} this INTENDS to replace an existing file — used to supersede a note in place
 * (#29), never to create. Throws if the resolved path escapes the brain (#76).
 */
export async function overwriteNote(brainDir: string, note: Note): Promise<void> {
  const absPath = resolveWithinBrain(brainDir, note.path);
  const content = serializeNote(note);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.${shortId()}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, absPath); // replace in place — supersede-not-delete keeps the file
}

/**
 * Mark a memory/decision note superseded IN PLACE (supersede-not-delete, ADR-0008/#29): set
 * `status: "superseded"` and `superseded_by: <survivorId>`, additive so it union-merges. Only
 * memory and decision carry these fields; other kinds are returned unchanged (no-op). Returns
 * the updated note, or the original when it isn't a supersede-able kind / is already superseded
 * by the same survivor.
 */
export async function supersedeNote(
  brainDir: string,
  relPath: string,
  survivorId: string,
): Promise<Note> {
  const note = await readNote(brainDir, relPath);
  const fm = note.frontmatter;
  if (fm.kind !== "memory" && fm.kind !== "decision") return note;
  if (fm.status === "superseded" && fm.superseded_by === survivorId) return note;
  const updated: Note = {
    ...note,
    frontmatter: { ...fm, status: "superseded", superseded_by: survivorId },
  };
  await overwriteNote(brainDir, updated);
  return updated;
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
    // Resilience (#80): one malformed/corrupt note (bad frontmatter, hand-edit, partial write)
    // must NOT take down the whole read path — listNotes feeds search, the index, and the derived
    // router, so a single throw here was a brain-wide read outage. Skip the bad note with a
    // stderr breadcrumb and keep going; the rest of canon stays readable.
    let note: Note;
    try {
      note = await readNote(brainDir, rel);
    } catch (err) {
      console.error(
        `[commonwealth] skipping unreadable note ${rel}: ${err instanceof Error ? err.message : err}`,
      );
      continue;
    }
    if (!kind || note.frontmatter.kind === kind) notes.push(note);
  }
  return notes;
}
