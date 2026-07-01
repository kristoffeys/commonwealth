import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The brain registry (issue #14): resolve which brain repo a given working directory maps
 * to. The plugin's SessionStart/SessionEnd hooks call {@link resolveBrainDir} to learn the
 * brain for `cwd` before injecting context or capturing learnings; the MCP server reads the
 * resolved path from `COMMONWEALTH_BRAIN_DIR`.
 *
 * Resolution is layered so a project can pin its brain explicitly, a brain repo resolves to
 * itself, teams can map by convention, and everything falls back to an env var — see
 * docs/03-distribution.md §3.
 */

/** Marker file, relative to a project dir, naming that project's brain: `.commonwealth/brain`. */
const MARKER_REL = path.join(".commonwealth", "brain");

/** A brain repo is identified by its `.commonwealth/config.json` (ADR-0009). */
const BRAIN_CONFIG_REL = path.join(".commonwealth", "config.json");

/** One prefix → brain mapping entry in the user registry file. */
export interface RegistryMapping {
  /** A path prefix (tilde-allowed); a `cwd` under it maps to {@link brain}. */
  prefix: string;
  /** The brain directory (tilde-allowed) to use for cwds under {@link prefix}. */
  brain: string;
}

/** Shape of the user registry JSON file (`~/.commonwealth/registry.json`). */
export interface Registry {
  mappings: RegistryMapping[];
}

/** Options for {@link resolveBrainDir}; all optional (env + registry path overrides). */
export interface ResolveBrainOptions {
  /** Explicit value to use instead of `process.env.COMMONWEALTH_BRAIN_DIR` (step 4). */
  env?: string;
  /** Explicit registry file path, overriding the default resolution (step 3). */
  registryPath?: string;
}

/** Expand a leading `~` to the home directory, then resolve to an absolute path. */
function expand(entry: string, base?: string): string {
  const home = os.homedir();
  if (entry === "~") return path.resolve(home);
  if (entry.startsWith("~/")) return path.resolve(home, entry.slice(2));
  return base ? path.resolve(base, entry) : path.resolve(entry);
}

/**
 * True when `child` is the same path as `parent` or nested beneath it. Boundary-safe:
 * `/work` does not contain `/workshop`. Mirrors curate/scope's `isUnder`. Callers pass
 * already-expanded absolute paths.
 */
function isUnder(child: string, parent: string): boolean {
  if (parent === path.sep) return true; // filesystem root contains everything
  return child === parent || child.startsWith(parent + path.sep);
}

/** Yield `startDir` and each ancestor up to the filesystem root. */
function* walkUp(startDir: string): Generator<string> {
  let current = path.resolve(startDir);
  for (;;) {
    yield current;
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/** Read a file, returning null on any error (missing/unreadable). */
async function readFileOrNull(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** True when `file` exists and is a regular file. */
async function isFile(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the user registry path. Order: explicit `registryPath` → `$COMMONWEALTH_REGISTRY`
 * (test override) → a `registry.json` sibling of `$COMMONWEALTH_CONFIG` (so tests that redirect
 * config also redirect the registry) → `~/.commonwealth/registry.json`.
 */
function resolveRegistryPath(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.COMMONWEALTH_REGISTRY) return process.env.COMMONWEALTH_REGISTRY;
  if (process.env.COMMONWEALTH_CONFIG) {
    return path.join(path.dirname(process.env.COMMONWEALTH_CONFIG), "registry.json");
  }
  return path.join(os.homedir(), ".commonwealth", "registry.json");
}

/** Parse the registry file into a normalized {@link Registry}; null on missing/invalid. */
async function loadRegistry(registryPath: string): Promise<Registry | null> {
  const raw = await readFileOrNull(registryPath);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const obj = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Partial<Registry>;
  const mappings = Array.isArray(obj.mappings) ? obj.mappings : [];
  const clean: RegistryMapping[] = [];
  for (const m of mappings) {
    if (
      m &&
      typeof m === "object" &&
      typeof (m as RegistryMapping).prefix === "string" &&
      typeof (m as RegistryMapping).brain === "string"
    ) {
      clean.push({ prefix: (m as RegistryMapping).prefix, brain: (m as RegistryMapping).brain });
    }
  }
  return { mappings: clean };
}

/**
 * Resolve the brain directory for `startDir`. First hit wins:
 *
 * 1. Walk up from `startDir`: a `.commonwealth/brain` marker file (a path, `~`-expanded and
 *    resolved relative to the dir holding it) pins the brain explicitly.
 * 2. Walk up: a directory that is itself a brain (`.commonwealth/config.json`) resolves to
 *    itself.
 * 3. The user registry file (`opts.registryPath` ?? `$COMMONWEALTH_REGISTRY` ?? sibling of
 *    `$COMMONWEALTH_CONFIG` ?? `~/.commonwealth/registry.json`): the first `prefix` (tilde-expanded,
 *    resolved) that `startDir` is under → its `brain` (tilde-expanded).
 * 4. `opts.env` ?? `process.env.COMMONWEALTH_BRAIN_DIR`, if set.
 * 5. `null`.
 *
 * Never throws on missing/unreadable files.
 */
export async function resolveBrainDir(
  startDir: string,
  opts: ResolveBrainOptions = {},
): Promise<string | null> {
  const start = path.resolve(startDir);

  // 1) Explicit marker file, nearest ancestor wins.
  for (const dir of walkUp(start)) {
    const markerPath = path.join(dir, MARKER_REL);
    const raw = await readFileOrNull(markerPath);
    if (raw !== null) {
      const target = raw.trim();
      if (target.length > 0) return expand(target, dir);
    }
  }

  // 2) A directory that is itself a brain, nearest ancestor wins.
  for (const dir of walkUp(start)) {
    if (await isFile(path.join(dir, BRAIN_CONFIG_REL))) return dir;
  }

  // 3) User registry mappings; first prefix that startDir is under wins.
  const registry = await loadRegistry(resolveRegistryPath(opts.registryPath));
  if (registry) {
    for (const mapping of registry.mappings) {
      if (isUnder(start, expand(mapping.prefix))) return expand(mapping.brain);
    }
  }

  // 4) Env fallback.
  const env = opts.env ?? process.env.COMMONWEALTH_BRAIN_DIR;
  if (env && env.length > 0) return path.resolve(env);

  // 5) Nothing matched.
  return null;
}

/**
 * Write the `.commonwealth/brain` marker in `projectDir` naming `brainPath`, creating the
 * `.commonwealth/` directory if needed. Used to pin a project to its brain (registry step 1).
 */
export async function setBrainMarker(projectDir: string, brainPath: string): Promise<void> {
  const markerPath = path.join(projectDir, MARKER_REL);
  await fs.mkdir(path.dirname(markerPath), { recursive: true });
  await fs.writeFile(markerPath, `${brainPath}\n`, "utf8");
}
