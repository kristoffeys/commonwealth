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

/**
 * A brain repo is identified by its `.commonwealth/schema-version` file (written by
 * `initBrain`). We deliberately do NOT key off `.commonwealth/config.json`: that name
 * collides with the per-user *scope* config at `~/.commonwealth/config.json` (ADR-0008),
 * which would otherwise make the home directory resolve as a brain. `schema-version` is a
 * brain-only scaffold artifact, so it disambiguates cleanly (ADR-0011).
 */
const BRAIN_IDENTITY_REL = path.join(".commonwealth", "schema-version");

/** One prefix → brain mapping entry in the user registry file. */
export interface RegistryMapping {
  /** A path prefix (tilde-allowed); a `cwd` under it maps to {@link brain}. */
  prefix: string;
  /** The brain directory (tilde-allowed) to use for cwds under {@link prefix}. */
  brain: string;
  /**
   * Optional git remote the brain can be cloned from when {@link brain} is missing locally
   * (ADR-0019 clone-on-demand). Absent for mappings written before ADR-0019 — those never
   * clone-on-demand (the pre-existing "brain must already exist" behavior).
   */
  remote?: string;
}

/** A resolved brain: its local directory plus the remote it clones from, when one is known. */
export interface ResolvedBrain {
  /** The brain directory (absolute), whether or not it exists on disk yet. */
  brain: string;
  /** The git remote to clone from if {@link brain} is missing (only ever set from a registry mapping). */
  remote?: string;
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

/** True when `dir` exists and is a directory (symlinks are followed). */
async function isDir(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
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

/**
 * Classified result of reading the registry file, so callers can tell "no file yet" (safe to
 * start empty) apart from "file present but unparseable" (must NOT be clobbered — #78).
 */
type RegistryLoad =
  { status: "ok"; registry: Registry } | { status: "missing" } | { status: "corrupt"; raw: string };

/** Read + classify the registry file. Never throws; distinguishes missing from corrupt. */
async function readRegistryFile(registryPath: string): Promise<RegistryLoad> {
  const raw = await readFileOrNull(registryPath);
  if (raw === null) return { status: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "corrupt", raw };
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
      const entry: RegistryMapping = {
        prefix: (m as RegistryMapping).prefix,
        brain: (m as RegistryMapping).brain,
      };
      const remote = (m as RegistryMapping).remote;
      if (typeof remote === "string" && remote.length > 0) entry.remote = remote;
      clean.push(entry);
    }
  }
  return { status: "ok", registry: { mappings: clean } };
}

/**
 * Parse the registry file into a normalized {@link Registry}; null on missing OR invalid. Used by
 * {@link resolveBrainDir}, which must never throw on a bad file — a corrupt registry simply
 * resolves no mappings (resolution falls through to env). Writers use {@link readRegistryFile}
 * directly so they can refuse to clobber a corrupt file (#78).
 */
async function loadRegistry(registryPath: string): Promise<Registry | null> {
  const load = await readRegistryFile(registryPath);
  return load.status === "ok" ? load.registry : null;
}

/**
 * Resolve the brain directory for `startDir`. First hit wins:
 *
 * 1. Walk up from `startDir`: a `.commonwealth/brain` marker file (a path, `~`-expanded and
 *    resolved relative to the dir holding it) pins the brain explicitly — but only when that
 *    target directory exists. A marker pointing at a missing brain is skipped so a stale/
 *    dangling marker falls through to the registry instead of hijacking resolution (#68).
 * 2. Walk up: a directory that is itself a brain (`.commonwealth/schema-version`) resolves to
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
  return (await resolveBrainMapping(startDir, opts))?.brain ?? null;
}

/**
 * Like {@link resolveBrainDir}, but returns the full {@link ResolvedBrain} — the brain path AND
 * the git `remote` to clone from when it came from a registry mapping (ADR-0019). Marker/self/env
 * layers carry no remote. Callers that may need to materialize a not-yet-cloned brain (the sync
 * daemon, `doctor`) use this; read-only callers can keep using {@link resolveBrainDir}. Still pure
 * and side-effect-free: it never touches the network or clones — that is the caller's explicit act.
 */
export async function resolveBrainMapping(
  startDir: string,
  opts: ResolveBrainOptions = {},
): Promise<ResolvedBrain | null> {
  const start = path.resolve(startDir);
  const registryPath = resolveRegistryPath(opts.registryPath);

  // 1) Explicit marker file, nearest ancestor wins — but only when its target actually
  //    exists. A marker whose target is missing (a brain that was moved/removed, or a stale
  //    marker left by an older onboarding) is skipped so resolution falls through to the
  //    registry rather than being hijacked to a dead path (#68). We keep walking up in case
  //    a higher ancestor carries a valid marker.
  for (const dir of walkUp(start)) {
    const markerPath = path.join(dir, MARKER_REL);
    const raw = await readFileOrNull(markerPath);
    if (raw !== null) {
      const target = raw.trim();
      if (target.length > 0) {
        const resolved = expand(target, dir);
        if (await isDir(resolved)) return { brain: resolved };
        // Dangling marker: ignore it and continue (next ancestor marker, then layers 2–4).
      }
    }
  }

  // 2) A directory that is itself a brain, nearest ancestor wins. Keyed off the brain-only
  //    `schema-version` file so the global scope-config dir is never mistaken for a brain.
  for (const dir of walkUp(start)) {
    if (await isFile(path.join(dir, BRAIN_IDENTITY_REL))) return { brain: dir };
  }

  // 3) User registry mappings; the LONGEST (most-specific) matching prefix wins, regardless of
  //    insertion order — so a narrow `/work/app` mapping is never shadowed by a broader `/work`
  //    one that merely happens to appear earlier in the file (#103). Carries the mapping's remote
  //    (ADR-0019) so a missing brain can clone-on-demand.
  const registry = await loadRegistry(registryPath);
  if (registry) {
    let best: ResolvedBrain | null = null;
    let bestLen = -1;
    for (const mapping of registry.mappings) {
      const prefix = expand(mapping.prefix);
      if (isUnder(start, prefix) && prefix.length > bestLen) {
        bestLen = prefix.length;
        best = {
          brain: expand(mapping.brain),
          ...(mapping.remote ? { remote: mapping.remote } : {}),
        };
      }
    }
    if (best !== null) return best;
  }

  // 4) Env fallback.
  const env = opts.env ?? process.env.COMMONWEALTH_BRAIN_DIR;
  if (env && env.length > 0) return { brain: path.resolve(env) };

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

/**
 * The default user registry path (public wrapper over the internal resolver): honors
 * `$COMMONWEALTH_REGISTRY`, then a `registry.json` sibling of `$COMMONWEALTH_CONFIG`, then
 * `~/.commonwealth/registry.json`. This is where onboarding writes the project→brain map
 * (resolution layer 3, the default source of truth).
 */
export function defaultRegistryPath(): string {
  return resolveRegistryPath();
}

/**
 * The default convenience-symlink directory (`brains/` next to the registry file), where
 * `~/.commonwealth/brains/<name>` symlinks let a human `ls`/`cd` their brains.
 */
export function defaultBrainsDir(): string {
  return path.join(path.dirname(defaultRegistryPath()), "brains");
}

/**
 * Add (or update) a `prefix → brain` mapping in the user registry, the default brain-wiring
 * source of truth (resolution layer 3). Both `prefix` and `brain` are `~`-expanded and
 * resolved to absolute paths; dedupe is by expanded prefix:
 *
 * - no mapping with this prefix → push `{ prefix, brain }` (`added: true`);
 * - a mapping with this prefix but a DIFFERENT brain → update it (`updated: true`);
 * - an identical mapping → no-op (`{ added: false, updated: false }`).
 *
 * Idempotent. Creates the registry's directory if missing and persists pretty (2-space) JSON
 * atomically (tmp file + rename) so a crash mid-write cannot corrupt it. A present-but-corrupt
 * registry is NOT clobbered: it is backed up to `registry.json.corrupt-<ts>` and a clear error is
 * thrown, so a transient/partial-write corruption never silently wipes every other project's
 * brain wiring (#78). A missing file is treated as an empty registry (the normal first-run case).
 */
export async function addRegistryMapping(
  prefix: string,
  brain: string,
  opts: string | { remote?: string; registryPath?: string } = {},
): Promise<{ added: boolean; updated: boolean }> {
  // Back-compat: a string third arg is the registry path (its long-standing signature).
  const registryPath =
    typeof opts === "string" ? opts : (opts.registryPath ?? defaultRegistryPath());
  const remote = typeof opts === "string" ? undefined : opts.remote;
  const absPrefix = expand(prefix);
  const absBrain = expand(brain);

  const load = await readRegistryFile(registryPath);
  if (load.status === "corrupt") {
    // Preserve the unparseable file rather than overwrite it, then refuse loudly. Wiring state
    // is user data; "never silently overwrite" (ADR-0003) applies here as much as to notes.
    const backup = `${registryPath}.corrupt-${Date.now()}`;
    await fs.rename(registryPath, backup).catch(() => fs.writeFile(backup, load.raw, "utf8"));
    throw new Error(
      `Refusing to overwrite a corrupt registry at ${registryPath} (backed up to ${backup}). ` +
        `Fix or remove it, then retry.`,
    );
  }
  const registry: Registry = load.status === "ok" ? load.registry : { mappings: [] };
  const existing = registry.mappings.find((m) => expand(m.prefix) === absPrefix);

  let added = false;
  let updated = false;
  if (!existing) {
    registry.mappings.push({ prefix: absPrefix, brain: absBrain, ...(remote ? { remote } : {}) });
    added = true;
  } else {
    const brainChanged = expand(existing.brain) !== absBrain;
    // Only overwrite an existing remote when a new one is given; never clear it implicitly.
    const remoteChanged = remote !== undefined && existing.remote !== remote;
    if (!brainChanged && !remoteChanged) return { added, updated };
    existing.prefix = absPrefix;
    existing.brain = absBrain;
    if (remote !== undefined) existing.remote = remote;
    updated = true;
  }

  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  // Atomic write: a crash mid-write leaves the old registry intact rather than a partial file.
  const tmp = `${registryPath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  await fs.rename(tmp, registryPath);
  return { added, updated };
}

/**
 * Drop a convenience symlink `<brainsDir>/<name> → <brainDir>` so a human can `ls`/`cd` their
 * brains. `name` is sanitized via `path.basename`; an empty/`.`/`..` name is rejected. If a
 * symlink already resolves to the target it is a no-op; a symlink pointing elsewhere is
 * replaced; a real (non-symlink) file/dir at the path is left intact and reported as skipped.
 * Never throws for unsupported/permission cases (Windows/EPERM/EACCES/ENOSYS/EEXIST) — those
 * are reported via `skipped`.
 */
export async function linkBrain(
  name: string,
  brainDir: string,
  brainsDir = defaultBrainsDir(),
): Promise<{ path: string; linked: boolean; skipped?: string }> {
  const safe = path.basename(name);
  if (safe === "" || safe === "." || safe === "..") {
    return { path: "", linked: false, skipped: "invalid name" };
  }

  const target = path.resolve(brainDir);
  const symlinkPath = path.join(brainsDir, safe);

  try {
    await fs.mkdir(brainsDir, { recursive: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { path: symlinkPath, linked: false, skipped: code ?? "cannot create brains dir" };
  }

  let existingStat: import("node:fs").Stats | null = null;
  try {
    existingStat = await fs.lstat(symlinkPath);
  } catch {
    existingStat = null;
  }

  if (existingStat) {
    if (existingStat.isSymbolicLink()) {
      let resolved: string | null = null;
      try {
        resolved = path.resolve(brainsDir, await fs.readlink(symlinkPath));
      } catch {
        resolved = null;
      }
      if (resolved === target) return { path: symlinkPath, linked: true };
      try {
        await fs.unlink(symlinkPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        return { path: symlinkPath, linked: false, skipped: code ?? "symlink unsupported" };
      }
    } else {
      return { path: symlinkPath, linked: false, skipped: "exists (not a symlink)" };
    }
  }

  try {
    await fs.symlink(target, symlinkPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { path: symlinkPath, linked: false, skipped: code ?? "symlink unsupported" };
  }
  return { path: symlinkPath, linked: true };
}
