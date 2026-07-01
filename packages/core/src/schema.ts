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

/** Fields common to every note kind. */
const baseShape = {
  id: z.string().min(1),
  title: z.string().min(1),
  tags: z.array(z.string()).default([]),
  created: IsoDate,
  updated: IsoDate.optional(),
  author: z.string().optional(),
  /** Wikilink targets (`[[id]]` or bare id) to related notes. */
  relates: z.array(z.string()).default([]),
};

export const MemoryFrontmatter = z.object({
  ...baseShape,
  kind: z.literal("memory"),
  status: z.enum(["active", "superseded", "stale"]).default("active"),
  /** Last time this fact was checked against reality (Kage-style verification). */
  verified: IsoDate.optional(),
  sources: z.array(z.string()).default([]),
  superseded_by: z.string().nullable().optional(),
});
export type MemoryFrontmatter = z.infer<typeof MemoryFrontmatter>;

export const DecisionFrontmatter = z.object({
  ...baseShape,
  kind: z.literal("decision"),
  status: z.enum(["proposed", "accepted", "superseded"]).default("proposed"),
  supersedes: z.array(z.string()).default([]),
  superseded_by: z.string().nullable().optional(),
  deciders: z.array(z.string()).default([]),
});
export type DecisionFrontmatter = z.infer<typeof DecisionFrontmatter>;

export const WorkStateFrontmatter = z.object({
  ...baseShape,
  kind: z.literal("work-state"),
  owner: z.string().optional(),
  status: z.enum(["planned", "in-progress", "blocked", "done"]).default("planned"),
});
export type WorkStateFrontmatter = z.infer<typeof WorkStateFrontmatter>;

export const PersonFrontmatter = z.object({
  ...baseShape,
  kind: z.literal("person"),
  name: z.string().min(1),
  org: z.string().optional(),
  role: z.string().optional(),
});
export type PersonFrontmatter = z.infer<typeof PersonFrontmatter>;

/** Discriminated union over `kind` — the validated frontmatter of any note. */
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
