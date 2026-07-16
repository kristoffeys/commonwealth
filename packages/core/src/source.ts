import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { slugify } from "./ids.js";
import { projectIdError } from "./projects.js";

const pexec = promisify(execFile);

/**
 * Resolve a stable project identity for `cwd` — the value stamped as a note's frontmatter
 * `source` so a shared brain can group/filter notes by originating project (ADR-0015).
 *
 * Order: the nearest ancestor git repo's `origin` remote, slugified to `owner/repo` → else
 * that repo root's basename → else the basename of `cwd`. Best-effort and never throws: git
 * being absent/erroring degrades to the basename. Returns `null` only for an empty input.
 */
export async function resolveProjectSource(cwd: string): Promise<string | null> {
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  const start = path.resolve(cwd);
  const root = findGitRoot(start);
  if (root) {
    const remote = await originUrl(root);
    const slug = remote ? slugFromRemote(remote) : null;
    return slug ?? path.basename(root);
  }
  return path.basename(start);
}

/**
 * The repo's identity slug (`owner/repo` from its git `origin`) — but ONLY when there is a real
 * git origin; `null` otherwise (no repo, or a repo without an origin). Unlike
 * {@link resolveProjectSource}, this never falls back to a basename, so callers can decide between
 * an identity (`repo:`) rule and a path (`prefix:`) rule when wiring a folder (ADR-0024).
 */
export async function repoIdentity(cwd: string): Promise<string | null> {
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  const root = findGitRoot(path.resolve(cwd));
  if (!root) return null;
  const remote = await originUrl(root);
  return remote ? slugFromRemote(remote) : null;
}

/**
 * A DECLARED engagement identity read from a `.commonwealth/project.json` manifest (ADR-0031).
 * `project` is the canonical engagement id; `customer` is the optional human/business name. A
 * `members` key may appear in a manifest (written by the future wizard) — we tolerate but do not
 * process it here.
 */
export interface ProjectManifest {
  project: string;
  customer?: string;
}

/** Manifest path relative to a working folder/repo. */
const MANIFEST_REL = path.join(".commonwealth", "project.json");

/**
 * Resolve the DECLARED project identity for `cwd` by walking up to the nearest
 * `.commonwealth/project.json` manifest (ADR-0031) — the save-time, primary identity path.
 *
 * The walk mirrors {@link resolveProjectSource}'s discipline: it starts at `cwd` and climbs, but
 * never above the nearest ancestor git repo's root (a committed manifest lives at the repo root, so
 * the root is the highest dir searched); for a non-git folder it climbs to the filesystem root.
 * Returns `{ project, customer? }` from the first manifest found, or `null` when none declares one.
 *
 * Never throws. A manifest that is unreadable, unparseable, or missing a usable `project` string is
 * treated as absent — but a PRESENT-yet-malformed manifest emits one stderr breadcrumb first, so a
 * corrupt declaration surfaces loudly rather than silently degrading to "no project" (the
 * loud-corrupt-config lesson from #210).
 */
export async function resolveProjectManifest(cwd: string): Promise<ProjectManifest | null> {
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  const start = path.resolve(cwd);
  const gitRoot = findGitRoot(start);
  let dir = start;
  for (;;) {
    const manifest = readManifest(path.join(dir, MANIFEST_REL));
    if (manifest) return manifest;
    // Boundary: never climb above the enclosing git repo's root (the highest dir a committed
    // manifest can live in); for a non-git folder, stop at the filesystem root.
    if (gitRoot && dir === gitRoot) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Read + validate one manifest file. Missing → null; malformed-but-present → breadcrumb + null. */
function readManifest(file: string): ProjectManifest | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null; // absent (or unreadable) — the ordinary "no manifest here" case
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(
      `[commonwealth] ignoring malformed project manifest at ${file}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.error(
      `[commonwealth] ignoring malformed project manifest at ${file}: not a JSON object`,
    );
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const project = typeof obj.project === "string" && obj.project.length > 0 ? obj.project : null;
  if (!project) {
    console.error(
      `[commonwealth] ignoring project manifest at ${file}: missing a "project" string`,
    );
    return null;
  }
  // Ingestion hardening (#241): a manifest is hand/tool-written and its `project` gets stamped onto
  // every note captured under it — reject a pathological id (over-long / path separator / control
  // char) here, loudly (breadcrumb) but non-fatally, so it can't be mass-stamped. Treat as absent,
  // matching the malformed-manifest posture above (#210 loud-corrupt discipline).
  const idErr = projectIdError(project);
  if (idErr) {
    console.error(`[commonwealth] ignoring project manifest at ${file}: ${idErr}`);
    return null;
  }
  const customer =
    typeof obj.customer === "string" && obj.customer.length > 0 ? obj.customer : undefined;
  return customer ? { project, customer } : { project };
}

/**
 * The capture stamp a {@link ProjectManifest} contributes (ADR-0031): the declared `project` id
 * (written to frontmatter `project`) and, when the manifest names a `customer`, a `customer:<slug>`
 * TAG rather than new frontmatter — tags already exist and are searchable, keeping the schema
 * surface small. Pure; the caller merges these onto each captured candidate.
 */
export function manifestStamp(manifest: ProjectManifest): { project: string; tag?: string } {
  const tag = manifest.customer ? `customer:${slugify(manifest.customer)}` : undefined;
  return tag ? { project: manifest.project, tag } : { project: manifest.project };
}

/** Nearest ancestor of `startDir` (inclusive) containing a `.git`, or null if none. */
function findGitRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** `git -C <root> config --get remote.origin.url`, or null if unset/unavailable. */
async function originUrl(root: string): Promise<string | null> {
  try {
    const { stdout } = await pexec("git", ["-C", root, "config", "--get", "remote.origin.url"]);
    const url = stdout.trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

/**
 * Reduce a git remote URL to a stable `owner/repo` identity (or bare `repo` when there is no
 * owner segment). Handles `git@host:owner/repo.git`, `https://host/owner/repo(.git)`, and
 * `ssh://host/owner/repo`. Returns null when nothing usable can be extracted.
 */
export function slugFromRemote(remote: string): string | null {
  // Normalize scp-style `git@host:owner/repo` to a slash-path, then drop scheme/host.
  let s = remote.trim().replace(/\.git$/i, "");
  s = s.replace(/^[a-z]+:\/\//i, "").replace(/^[^@]+@/, ""); // strip scheme and user@
  s = s.replace(/^[^/:]+[:/]/, ""); // strip host + first separator (: for scp, / for url)
  const parts = s.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  return parts.slice(-2).join("/");
}
