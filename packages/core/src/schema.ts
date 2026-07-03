import { z } from "zod";

/**
 * The four note kinds that make up a brain. See docs/02-data-model.md.
 * One concept per file; kind determines the folder it lives in.
 */
export const NOTE_KINDS = ["memory", "decision", "work-state", "person"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

/** Folder each kind is stored in, relative to the brain root. */
export const KIND_DIR: Record<NoteKind, string> = {
  memory: "memory",
  decision: "decisions",
  "work-state": "work-state",
  person: "people",
};

/**
 * Dates are stored as `YYYY-MM-DD` strings. YAML parsers coerce unquoted dates to
 * JS `Date`; this preprocessor normalizes both back to the canonical string form.
 */
export const IsoDate = z.preprocess(
  (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected a YYYY-MM-DD date"),
);

/**
 * A note `id` must be a single, safe filename segment: it is the file's stem and is joined onto
 * the brain path to build the canonical write path (`<kind>/<id>.md`). Rejecting slashes and
 * `..` here — at the one point every note (written or read) is validated — stops a crafted id
 * (`../../evil`) from escaping the brain on approve/write (#77). Legitimate ids from `makeNoteId`
 * are `<date>-<slug>-<suffix>`, which never contain these.
 */
const SafeId = z
  .string()
  .min(1)
  .refine((s) => !s.includes("/") && !s.includes("\\") && s !== "." && s !== "..", {
    message: "id must be a single path segment (no '/', '\\\\', or '..')",
  });

/** Fields common to every note kind. */
const baseShape = {
  id: SafeId,
  title: z.string().min(1),
  tags: z.array(z.string()).default([]),
  created: IsoDate,
  updated: IsoDate.optional(),
  author: z.string().optional(),
  /**
   * Originating project the note was captured from — a stable repo identity (git `origin`
   * slug, else the repo-root basename). Lets a shared brain group/filter notes by project
   * (ADR-0015). Optional: pre-existing and non-project notes are "unattributed".
   */
  source: z.string().optional(),
  /** Wikilink targets (`[[id]]` or bare id) to related notes. */
  relates: z.array(z.string()).default([]),
};

export const MemoryFrontmatter = z
  .object({
    ...baseShape,
    kind: z.literal("memory"),
    status: z.enum(["active", "superseded", "stale"]).default("active"),
    /** Last time this fact was checked against reality (Kage-style verification). */
    verified: IsoDate.optional(),
    sources: z.array(z.string()).default([]),
    superseded_by: z.string().nullable().optional(),
  })
  .passthrough();
export type MemoryFrontmatter = z.infer<typeof MemoryFrontmatter>;

export const DecisionFrontmatter = z
  .object({
    ...baseShape,
    kind: z.literal("decision"),
    status: z.enum(["proposed", "accepted", "superseded"]).default("proposed"),
    supersedes: z.array(z.string()).default([]),
    superseded_by: z.string().nullable().optional(),
    deciders: z.array(z.string()).default([]),
  })
  .passthrough();
export type DecisionFrontmatter = z.infer<typeof DecisionFrontmatter>;

export const WorkStateFrontmatter = z
  .object({
    ...baseShape,
    kind: z.literal("work-state"),
    owner: z.string().optional(),
    status: z.enum(["planned", "in-progress", "blocked", "done"]).default("planned"),
  })
  .passthrough();
export type WorkStateFrontmatter = z.infer<typeof WorkStateFrontmatter>;

export const PersonFrontmatter = z
  .object({
    ...baseShape,
    kind: z.literal("person"),
    name: z.string().min(1),
    org: z.string().optional(),
    role: z.string().optional(),
  })
  .passthrough();
export type PersonFrontmatter = z.infer<typeof PersonFrontmatter>;

/**
 * Discriminated union over `kind` — the validated frontmatter of any note. Each member is
 * `.passthrough()` so unknown keys survive parse→serialize (#81): a field this build's schema
 * doesn't know (a user's custom key, or one a newer schema added) is preserved rather than
 * silently dropped when a note is re-serialized (e.g. sync's conflict sibling rewrite).
 */
export const Frontmatter = z.discriminatedUnion("kind", [
  MemoryFrontmatter,
  DecisionFrontmatter,
  WorkStateFrontmatter,
  PersonFrontmatter,
]);
export type Frontmatter = z.infer<typeof Frontmatter>;

/** A parsed note: validated frontmatter + markdown body + repo-relative path. */
export interface Note {
  frontmatter: Frontmatter;
  /** Markdown content after the frontmatter block. */
  body: string;
  /** Path relative to the brain root, e.g. `memory/2026-07-01-foo-a1b2.md`. */
  path: string;
}

/** Current on-disk schema version, pinned in `.commonwealth/schema-version`. */
export const SCHEMA_VERSION = 1;
