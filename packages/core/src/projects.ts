import { promises as fs } from "node:fs";
import path from "node:path";
import type { Note } from "./schema.js";

/**
 * Project-identity layer (ADR-0031). `source` (ADR-0015) records WHERE a note was captured
 * (provenance); it never changes. IDENTITY — which engagement a note belongs to — is resolved at
 * read time from two inputs, in this order (see {@link resolveNoteProject}):
 *
 *   1. the note's own `project` frontmatter (a save-time manifest declared it — the primary path);
 *   2. the brain's alias map (this module): a curator-editable, versioned mapping of one project id
 *      to the set of `source`s that make up the engagement (the retroactive/corrective layer);
 *   3. the note's `source` itself, as a singleton project (today's default behavior, unchanged).
 *
 * The alias map is a DERIVATION INPUT, exactly like brain config (ADR-0003/0005): linking two
 * sources reorganizes every grouped surface without touching a single note file, and derived
 * artifacts rebuild byte-deterministically from (notes + this map).
 */

/** One engagement's entry in the alias map: its member sources and optional business/customer name. */
export interface ProjectAliasEntry {
  /** Optional human/business name for the engagement (distinct from the project id key). */
  customer?: string;
  /** The `source` values (ADR-0015) that belong to this project. */
  sources: string[];
}

/** The brain-owned alias map: canonical project id → its {@link ProjectAliasEntry}. */
export type ProjectAliasMap = Record<string, ProjectAliasEntry>;

/**
 * Upper bound on a project id's length (chars). A project id is stamped into note frontmatter and,
 * once `adopt` runs, potentially onto hundreds of notes at once — so a pathological value must be
 * rejected at ingestion rather than mass-written. 256 is generous for any real engagement name.
 */
export const MAX_PROJECT_ID_LENGTH = 256;

/**
 * Validate a project id at INGESTION (manifest read, `project link`, `project adopt`). Returns a
 * human-readable reason naming the violated constraint, or `null` when the id is acceptable.
 *
 * Constraints (deliberately minimal so existing valid ids like `acme-eng` keep working):
 *   - non-empty, at most {@link MAX_PROJECT_ID_LENGTH} chars;
 *   - no path separators (`/` or `\`) — a project id is a grouping key, not a path, and blocking
 *     separators keeps it from ever being mistaken for one;
 *   - no control characters (incl. DEL) — printable text only, so it can't corrupt a terminal,
 *     a YAML frontmatter block, or a router heading.
 *
 * Pure; callers decide how to surface the failure (a breadcrumb + skip on the capture hot path, a
 * clear error + non-zero exit on the CLI).
 */
export function projectIdError(id: string): string | null {
  if (typeof id !== "string" || id.length === 0) return "project id must be a non-empty string";
  if (id.length > MAX_PROJECT_ID_LENGTH) {
    return `project id exceeds the ${MAX_PROJECT_ID_LENGTH}-character limit (was ${id.length})`;
  }
  if (/[/\\]/.test(id)) return "project id must not contain a path separator ('/' or '\\')";
  // eslint-disable-next-line no-control-regex -- intentional: reject C0 controls + DEL
  if (/[\u0000-\u001f\u007f]/.test(id)) return "project id must not contain control characters";
  return null;
}

/** Alias-map path relative to the brain root. Versioned + synced with the brain. */
const PROJECTS_REL = path.join(".commonwealth", "projects.json");

/** Absolute path to a brain's project alias map (`<brainDir>/.commonwealth/projects.json`). */
export function projectsMapPath(brainDir: string): string {
  return path.join(brainDir, PROJECTS_REL);
}

/** Read + classify the alias-map file. Never throws; distinguishes missing from corrupt. */
type AliasLoad =
  | { status: "missing" }
  | { status: "ok"; map: ProjectAliasMap }
  | { status: "corrupt"; raw: string; error: string };

async function readAliasFile(file: string): Promise<AliasLoad> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return { status: "missing" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { status: "corrupt", raw, error: err instanceof Error ? err.message : String(err) };
  }
  // A file that parses but isn't a JSON object is not a usable map — treat as corrupt so it
  // surfaces loudly rather than silently degrading to "no links" (the #210 lesson).
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "corrupt", raw, error: "projects map must be a JSON object" };
  }
  return { status: "ok", map: normalizeAliasMap(parsed as Record<string, unknown>) };
}

/** Keep only well-formed entries; a malformed one is dropped rather than throwing (partial-edit safe). */
function normalizeAliasMap(raw: Record<string, unknown>): ProjectAliasMap {
  const out: ProjectAliasMap = {};
  for (const [projectId, value] of Object.entries(raw)) {
    if (!projectId || typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const sources = Array.isArray(entry.sources)
      ? entry.sources.filter((s): s is string => typeof s === "string" && s.length > 0)
      : [];
    const customer =
      typeof entry.customer === "string" && entry.customer.length > 0 ? entry.customer : undefined;
    out[projectId] = customer ? { customer, sources } : { sources };
  }
  return out;
}

/** Brains already warned about a corrupt alias map this process, so the breadcrumb fires once each. */
const corruptWarned = new Set<string>();

/**
 * Load a brain's project alias map for READS (derivation, resolution). Never throws: a missing file
 * yields `{}`, and a present-but-corrupt file is treated as absent (`{}`) after ONE stderr
 * breadcrumb per file per process — a corrupt map must never crash a read, but it must not be
 * silent either (#210). WRITERS use {@link persistProjectAliasMap}, which REFUSES to overwrite a
 * corrupt file (backup + throw) rather than clobbering it (the #78 discipline).
 */
export async function loadProjectAliasMap(brainDir: string): Promise<ProjectAliasMap> {
  const file = projectsMapPath(brainDir);
  const load = await readAliasFile(file);
  if (load.status === "corrupt") {
    const key = path.resolve(file);
    if (!corruptWarned.has(key)) {
      corruptWarned.add(key);
      console.error(
        `[commonwealth] project alias map at ${key} is corrupt (${load.error}); ` +
          `treating it as empty for reads — fix it, then relink.`,
      );
    }
    return {};
  }
  return load.status === "ok" ? load.map : {};
}

/**
 * Load, guard-against-corrupt, mutate, and atomically persist the alias map. Mirrors the
 * `persistRegistry` discipline (#78): a present-but-unparseable file is backed up to
 * `projects.json.corrupt-<ts>` and a clear error is thrown — a writer must never clobber a map it
 * could not read. Writes pretty JSON via tmp-file + rename so a crash mid-write leaves the prior
 * file intact. The `mutate` callback edits the map in place.
 */
export async function persistProjectAliasMap(
  brainDir: string,
  mutate: (map: ProjectAliasMap) => void,
): Promise<void> {
  const file = projectsMapPath(brainDir);
  const load = await readAliasFile(file);
  if (load.status === "corrupt") {
    const backup = `${file}.corrupt-${Date.now()}`;
    await fs.rename(file, backup).catch(() => fs.writeFile(backup, load.raw, "utf8"));
    throw new Error(
      `Refusing to overwrite a corrupt project alias map at ${file} (backed up to ${backup}). ` +
        `Fix or remove it, then retry.`,
    );
  }
  const map: ProjectAliasMap = load.status === "ok" ? load.map : {};
  mutate(map);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(sortAliasMap(map), null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

/** Deterministic serialization: project ids and each entry's sources sorted, so writes are stable. */
function sortAliasMap(map: ProjectAliasMap): ProjectAliasMap {
  const out: ProjectAliasMap = {};
  for (const projectId of Object.keys(map).sort()) {
    const entry = map[projectId]!;
    const sources = [...new Set(entry.sources)].sort();
    out[projectId] = entry.customer ? { customer: entry.customer, sources } : { sources };
  }
  return out;
}

/**
 * Resolve a note's engagement identity (ADR-0031), pure. Order: the note's own `project`
 * frontmatter (a manifest declared it — wins even if the alias map disagrees, since write-time
 * already warned) → the alias-map project whose `sources` contains the note's `source` → the
 * note's `source` itself as a singleton project. Returns `null` only for a note with neither a
 * declared project nor a `source` (an unattributed note).
 */
export function resolveNoteProject(note: Note, aliasMap: ProjectAliasMap): string | null {
  const declared = note.frontmatter.project;
  if (typeof declared === "string" && declared.length > 0) return declared;
  const source = note.frontmatter.source;
  if (typeof source === "string" && source.length > 0) {
    const linked = projectForSource(source, aliasMap);
    return linked ?? source;
  }
  return null;
}

/** The alias-map project id whose `sources` includes `source`, or null. First match wins (sorted). */
export function projectForSource(source: string, aliasMap: ProjectAliasMap): string | null {
  for (const projectId of Object.keys(aliasMap).sort()) {
    if (aliasMap[projectId]!.sources.includes(source)) return projectId;
  }
  return null;
}

/** In-place link: add `sources` to `projectId`'s entry (creating it), de-duplicated. */
export function linkSources(map: ProjectAliasMap, projectId: string, sources: string[]): void {
  const entry = map[projectId] ?? { sources: [] };
  entry.sources = [...new Set([...entry.sources, ...sources])];
  map[projectId] = entry;
}

/**
 * In-place unlink: remove `sources` from `projectId`'s entry. Removing the last source deletes the
 * entry entirely (an empty project has no meaning). No-op if the project is absent.
 */
export function unlinkSources(map: ProjectAliasMap, projectId: string, sources: string[]): void {
  const entry = map[projectId];
  if (!entry) return;
  const drop = new Set(sources);
  entry.sources = entry.sources.filter((s) => !drop.has(s));
  if (entry.sources.length === 0) delete map[projectId];
  else map[projectId] = entry;
}
