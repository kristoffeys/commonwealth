import { today } from "./ids.js";
import { listNotes } from "./notes.js";
import { loadProjectAliasMap, resolveNoteProject, type ProjectAliasMap } from "./projects.js";
import type { Note } from "./schema.js";

/**
 * Brain-health / trust rollup (#109). A shared brain rots if it can't tell fresh from stale, so
 * this surfaces decay: stale, never-verified, contradiction-flagged, and orphaned notes, plus a
 * single headline freshness/trust score. Pure and read-only — computed from the note set (the
 * source of truth), never written back (ADR-0003).
 */

/** Default age (days) past which an active memory note counts as stale. Overridable per call. */
export const DEFAULT_STALE_AFTER_DAYS = 90;

/** One bucket of the rollup: how many notes, and which (by id, for drill-down). */
export interface HealthBucket {
  count: number;
  ids: string[];
}

/** The brain-health rollup for a note set. */
export interface HealthReport {
  /** Notes considered. */
  total: number;
  /** Explicitly `status: stale`, or an active memory note older than the stale threshold. */
  stale: HealthBucket;
  /** Active memory notes never checked against reality (no `verified` date). */
  unverified: HealthBucket;
  /** Notes flagged as contradicted (a `contradicted` tag; the future embeddings signal, #107). */
  contradicted: HealthBucket;
  /** Notes nothing else links to (no inbound `relates`/`supersedes`/`superseded_by`/`sources`). */
  orphaned: HealthBucket;
  /** Composite freshness/trust score, 0–100 (100 = nothing decayed; empty brain = 100). */
  score: number;
}

/** Options for {@link brainHealth}. */
export interface HealthOptions {
  /** Age in days past which an active memory note is stale (default {@link DEFAULT_STALE_AFTER_DAYS}). */
  staleAfterDays?: number;
  /** "Today" as `YYYY-MM-DD`; defaults to the real date. Injectable for deterministic tests. */
  now?: string;
}

/** Whole days between two `YYYY-MM-DD` dates (`now - then`); negative dates/parse errors → 0. */
function daysBetween(now: string, then: string): number {
  const a = Date.parse(`${now}T00:00:00Z`);
  const b = Date.parse(`${then}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.floor((a - b) / 86_400_000));
}

/** Case-insensitive check for a `contradicted` tag. */
function isContradicted(note: Note): boolean {
  return note.frontmatter.tags.some((t) => t.toLowerCase() === "contradicted");
}

/**
 * Compute the {@link HealthReport} for `notes`. Definitions:
 * - **stale**: `status: stale` (memory), OR an `active` memory note whose last touch
 *   (`verified` ?? `updated` ?? `created`) is older than `staleAfterDays`.
 * - **unverified**: `active` memory notes with no `verified` date.
 * - **contradicted**: any note carrying a `contradicted` tag.
 * - **orphaned**: notes whose id is referenced by NO other note (no inbound links).
 * - **score**: `100 * (1 - (serious + 0.5·soft)/total)`, where serious = stale ∪ contradicted and
 *   soft = (unverified ∪ orphaned) minus serious. Clamped to [0,100]; empty brain scores 100.
 */
export function brainHealth(notes: Note[], opts: HealthOptions = {}): HealthReport {
  const staleAfterDays = opts.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  const now = opts.now ?? today();

  // Inbound-link set: every id referenced by some note (so a note IS linked to).
  const referenced = new Set<string>();
  for (const n of notes) {
    const fm = n.frontmatter;
    const refs = [
      ...fm.relates,
      ...[fm.author_ref].filter((v): v is string => typeof v === "string"),
      ...(fm.kind === "memory" ? fm.sources : []),
      ...(fm.kind === "decision" ? fm.supersedes : []),
      ...(fm.kind === "memory" || fm.kind === "decision"
        ? [fm.superseded_by].filter((v): v is string => typeof v === "string")
        : []),
    ];
    // Links may be `[[id]]` or a bare id — normalize the wikilink form.
    for (const r of refs) referenced.add(r.replace(/^\[\[|\]\]$/g, ""));
  }

  const stale: string[] = [];
  const unverified: string[] = [];
  const contradicted: string[] = [];
  const orphaned: string[] = [];

  for (const n of notes) {
    const fm = n.frontmatter;
    const id = fm.id;

    if (fm.kind === "memory") {
      if (fm.status === "stale") {
        stale.push(id);
      } else if (fm.status === "active") {
        const lastTouch = fm.verified ?? fm.updated ?? fm.created;
        if (daysBetween(now, lastTouch) > staleAfterDays) stale.push(id);
        if (!fm.verified) unverified.push(id);
      }
    }

    if (isContradicted(n)) contradicted.push(id);
    if (!referenced.has(id)) orphaned.push(id);
  }

  const serious = new Set<string>([...stale, ...contradicted]);
  const soft = new Set<string>([...unverified, ...orphaned].filter((id) => !serious.has(id)));

  const total = notes.length;
  const score =
    total === 0
      ? 100
      : Math.max(
          0,
          Math.min(100, Math.round(100 * (1 - (serious.size + 0.5 * soft.size) / total))),
        );

  const bucket = (ids: string[]): HealthBucket => ({ count: ids.length, ids: ids.sort() });
  return {
    total,
    stale: bucket(stale),
    unverified: bucket(unverified),
    contradicted: bucket(contradicted),
    orphaned: bucket(orphaned),
    score,
  };
}

/** Load a brain's notes and compute its {@link HealthReport}. Read-only; never writes canon. */
export async function computeBrainHealth(
  brainDir: string,
  opts: HealthOptions = {},
): Promise<HealthReport> {
  return brainHealth(await listNotes(brainDir), opts);
}

/** Sentinel label for notes with no resolved project (unattributed) in a per-project rollup. */
export const UNATTRIBUTED_PROJECT = "(unattributed)";

/** A brain-health rollup for one resolved engagement (ADR-0031). */
export interface ProjectHealth {
  /** Resolved project id (or {@link UNATTRIBUTED_PROJECT} for notes with no identity). */
  project: string;
  /** The health report over just this project's notes. */
  report: HealthReport;
}

/**
 * Roll up brain health PER RESOLVED PROJECT (ADR-0031): group notes by {@link resolveNoteProject}
 * against `aliasMap` — so sources linked into one engagement roll up together and the score reflects
 * the engagement, not the accident of which repo/folder a fact was captured in — then compute a
 * {@link HealthReport} per group. Pure; sorted by project id with the unattributed bucket last for
 * determinism. `orphaned` is still computed within each group (inbound links across projects are
 * rare and a cross-project link is exactly the kind of orphan a rollup should surface).
 */
export function healthByProject(
  notes: Note[],
  aliasMap: ProjectAliasMap,
  opts: HealthOptions = {},
): ProjectHealth[] {
  const groups = new Map<string, Note[]>();
  for (const n of notes) {
    const project = resolveNoteProject(n, aliasMap) ?? UNATTRIBUTED_PROJECT;
    (groups.get(project) ?? groups.set(project, []).get(project)!).push(n);
  }
  const labels = [...groups.keys()].sort((a, b) => {
    if (a === UNATTRIBUTED_PROJECT) return b === UNATTRIBUTED_PROJECT ? 0 : 1;
    if (b === UNATTRIBUTED_PROJECT) return -1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return labels.map((project) => ({ project, report: brainHealth(groups.get(project)!, opts) }));
}

/** Load a brain's notes + alias map and roll up {@link healthByProject}. Read-only. */
export async function computeHealthByProject(
  brainDir: string,
  opts: HealthOptions = {},
): Promise<ProjectHealth[]> {
  const [notes, aliasMap] = await Promise.all([listNotes(brainDir), loadProjectAliasMap(brainDir)]);
  return healthByProject(notes, aliasMap, opts);
}
