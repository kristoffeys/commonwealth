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
export const SafeId = z
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
  /** Stable id of the contributor `person` note responsible for this write. */
  author_ref: SafeId.optional(),
  /**
   * Originating project the note was captured from — a stable repo identity (git `origin`
   * slug, else the repo-root basename). Lets a shared brain group/filter notes by project
   * (ADR-0015). Optional: pre-existing and non-project notes are "unattributed".
   */
  source: z.string().optional(),
  /**
   * Declared engagement IDENTITY, distinct from the capture PROVENANCE in `source` (ADR-0031).
   * Stamped at capture only when a `.commonwealth/project.json` manifest DECLARES it in the working
   * folder/repo — so a customer's business folder and dev repo(s) file under one project id without
   * rewriting `source`. Optional and additive: absent means "resolve identity from the alias map or
   * fall back to `source` as a singleton project" (see `resolveNoteProject`). Never rewritten on an
   * existing note — retroactive linking uses the read-time alias map, not a frontmatter edit.
   */
  project: z.string().optional(),
  /**
   * Opt-in marker that this note may **graduate** to the org-brain — the audience-widening,
   * cross-trust-boundary promotion of knowledge that recurs across ≥2 project brains (ADR-0023,
   * #168, #110). Absent/`false` means the note stays in its repo; only `graduate: true` makes it
   * eligible, and even then it is staged for manual review, never auto-promoted. Optional and
   * additive — a note without it is simply never a graduation candidate (no schema-version bump).
   */
  graduate: z.boolean().optional(),
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
    /**
     * Ids of canon notes this note is judged to CONTRADICT (ADR-0030, #214). Set at capture time
     * by the LLM curation pass when a candidate makes a claim incompatible with existing canon —
     * the note is kept (never auto-rejected), but the disagreement is recorded here and surfaced in
     * receipts / the review queue so a human (or the curator agent, #198) can reconcile. Optional
     * and additive; absent means "no known contradiction".
     */
    contradicts: z.array(z.string()).optional(),
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
    /** Ids of canon notes this decision is judged to CONTRADICT (ADR-0030, #214). See {@link MemoryFrontmatter.contradicts}. */
    contradicts: z.array(z.string()).optional(),
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
    /** Stable normalized identity used to make automatic contributor creation idempotent. */
    attribution_key: z.string().optional(),
    email: z.string().email().optional(),
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
