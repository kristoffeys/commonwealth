import GithubSlugger from "github-slugger";
import { customAlphabet } from "nanoid";
import { KIND_DIR, type NoteKind } from "./schema.js";

/**
 * 4-char lowercase-alphanumeric suffix. ~1.7M values — its only job is to make two
 * concurrent writes of the same title+date produce *different* filenames, so git
 * unions them instead of conflicting. See ADR-0003.
 */
const nano = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 4);

/** A fresh collision-avoidance suffix. */
export function shortId(): string {
  return nano();
}

/** URL/filename-safe slug of a title, capped so filenames stay reasonable. */
export function slugify(title: string): string {
  const slugger = new GithubSlugger();
  const slug = slugger.slug(title).slice(0, 60);
  return slug.replace(/-+$/, "");
}

/**
 * Build a note id of the form `<created>-<slug>-<shortid>`, e.g.
 * `2026-07-01-auth-choice-a1b2`. The id equals the filename stem and is stable.
 */
export function makeNoteId(title: string, created: string, suffix: string = shortId()): string {
  return `${created}-${slugify(title)}-${suffix}`;
}

/**
 * A filesystem-safe single path segment for a project `source` (ADR-0015). The source may be
 * an `owner/repo` slug; we flatten separators so a project is exactly one folder level
 * (`<project>/<kind>/<id>.md`), keeping the tree a fixed depth. The full source stays in
 * frontmatter. Empty/invalid input yields "" (→ unattributed, note lives at the kind root).
 */
export function sourceSegment(source: string | undefined): string {
  if (typeof source !== "string") return "";
  const seg = source
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  return seg;
}

/**
 * Repo-relative path for a note. With a project `source` the note lives under a per-project
 * subtree (`<project>/<kind>/<id>.md`, ADR-0015); without one it stays at the kind root
 * (`<kind>/<id>.md`) — which is also the back-compat location for pre-provenance notes.
 */
export function pathForNote(kind: NoteKind, id: string, source?: string): string {
  const seg = sourceSegment(source);
  return seg ? `${seg}/${KIND_DIR[kind]}/${id}.md` : `${KIND_DIR[kind]}/${id}.md`;
}

/** `YYYY-MM-DD` for a given date (defaults to now). */
export function today(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}
