import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoIdentity, resolveProjectSource } from "./source.js";

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

/** A resolved brain: its local directory plus the remote it clones from, when one is known. */
export interface ResolvedBrain {
  /** The brain directory (absolute), whether or not it exists on disk yet. */
  brain: string;
  /** The git remote to clone from if {@link brain} is missing (only ever set from a registry mapping). */
  remote?: string;
}

/**
 * One rule in the unified ruleset (ADR-0024). A rule has exactly one **matcher** and one
 * **outcome**.
 *
 * Matchers (precedence tier, most-specific first): `repo` (exact `owner/repo`) > `org`
 * (`owner/*` or `owner`) > `prefix` (a `~`-expandable path prefix; longest wins within the tier)
 * > the catch-all. `repo`/`org` are matched against {@link resolveProjectSource} (a cwd's git
 * `origin` reduced to a slug, ADR-0015), so they follow a repo across worktrees, clones, and
 * machines — which path prefixes cannot. Any matcher field whose value is `"*"` is the catch-all
 * (matches everything, lowest precedence).
 *
 * Outcomes: `brain` routes here; `deny: true` means "never capture here" (wins on a
 * specificity tie); neither (a **bare allow**) routes to the registry's {@link Registry.defaultBrain}.
 */
export interface Rule {
  /** Exact `owner/repo` identity match (case-insensitive), or `"*"` for the catch-all. */
  repo?: string;
  /** Owner match: `"owner/*"` or `"owner"` (case-insensitive), or `"*"` for the catch-all. */
  org?: string;
  /** Path-prefix match (`~`-allowed); a `cwd` under it matches. `"*"` is the catch-all. */
  prefix?: string;
  /** Route matched cwds here (`~`-allowed). Omitted on a deny rule or a bare allow. */
  brain?: string;
  /** When true, matched cwds are out of scope — never captured. Wins over an allow on a tie. */
  deny?: boolean;
  /** Git remote for {@link brain}'s clone-on-demand (ADR-0019). */
  remote?: string;
  /**
   * `"local"` (this machine only, never synced — the default) vs `"shared"` (may live with the
   * brain and propagate to teammates). Personal denies stay `local`. Reserved for the shared-vs-local
   * work (ADR-0024 §5); parsed and preserved but not yet acted on.
   */
  origin?: "local" | "shared";
}

/**
 * The outcome of resolving a working directory against the unified ruleset (ADR-0024). Unlike
 * {@link ResolvedBrain} (`brain | null`), this distinguishes an explicit **deny** (a rule said
 * "out of scope here") from **none** (nothing matched) — the two feed different hook receipts.
 * This three-way result IS the scope gate: `brain` = in scope for that brain, `denied` = out of
 * scope, `none` = nothing configured here.
 */
export type BrainResolution =
  { kind: "brain"; brain: string; remote?: string } | { kind: "denied" } | { kind: "none" };

/** Shape of the per-user config JSON file (`~/.commonwealth/config.json`). */
export interface Registry {
  /**
   * The unified ruleset (ADR-0024): match by git identity or path → brain / deny / default.
   * The single brain-wiring source of truth.
   */
  rules?: Rule[];
  /**
   * The brain a *matched* rule routes to when it names no `brain` (a bare allow). NOT a catch-all
   * for unmatched directories — an unmatched cwd still resolves to `none`, so a default brain never
   * turns on capture-everywhere (that is an explicit `*` rule). ADR-0024 §4.
   */
  defaultBrain?: ResolvedBrain;
  /**
   * The org-brain for this user: the shared brain that cross-brain knowledge graduates *up* to
   * (ADR-0023, #167). A deliberately *local per-machine* pointer — locating the org-brain must not
   * require scanning every wired brain's config. Optional: absent until designated via
   * {@link setOrgBrain} (`commonwealth org-brain set`).
   */
  orgBrain?: ResolvedBrain;
  /**
   * Legacy scope allowlist (ADR-0008), kept **readable as sugar** (ADR-0024 §3/§7): each entry is
   * folded into resolution as a bare-allow `prefix` rule so existing configs keep working with zero
   * migration. New wiring uses {@link rules} directly (the allow semantic is "matches a routing
   * rule"). Never written by core writers — the scope CLI owns this key.
   */
  allow?: string[];
  /**
   * Legacy scope denylist (ADR-0008), kept **readable as sugar** (ADR-0024 §3/§7): each entry is
   * folded into resolution as a `prefix` **deny** rule, so a personal `deny ~/finances` still yields
   * `denied` — the single out-of-scope signal now that {@link resolveBrain} *is* the scope gate and
   * `isInScope` is retired. Never written by core writers — the scope CLI owns this key.
   */
  deny?: string[];
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
 * Resolve the single per-user config file (ADR-0024 §6): everything — routing `rules`,
 * `defaultBrain`, `orgBrain` — lives in one `~/.commonwealth/config.json` (the same file curate
 * reads its scope from). Order: explicit `registryPath` → `$COMMONWEALTH_REGISTRY` (deprecated
 * test alias) → `$COMMONWEALTH_CONFIG` (the config file itself) → `~/.commonwealth/config.json`.
 */
function resolveRegistryPath(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.COMMONWEALTH_REGISTRY) return process.env.COMMONWEALTH_REGISTRY;
  if (process.env.COMMONWEALTH_CONFIG) return process.env.COMMONWEALTH_CONFIG;
  return path.join(os.homedir(), ".commonwealth", "config.json");
}

/**
 * Classified result of reading the registry file, so callers can tell "no file yet" (safe to
 * start empty) apart from "file present but unparseable" (must NOT be clobbered — #78).
 */
type RegistryLoad =
  | { status: "ok"; registry: Registry; rawObj: Record<string, unknown> }
  | { status: "missing" }
  | { status: "corrupt"; raw: string };

/**
 * Validate one raw rule (ADR-0024). Returns a clean {@link Rule} or null. A rule must have at
 * least one non-empty string matcher (`repo` / `org` / `prefix`); the outcome fields (`brain`,
 * `deny`, `remote`, `origin`) are copied only when well-typed. Never throws.
 */
function parseRule(raw: unknown): Rule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;

  const repo = str(r.repo);
  const org = str(r.org);
  const prefix = str(r.prefix);
  if (!repo && !org && !prefix) return null; // no matcher → not a usable rule

  const rule: Rule = {};
  if (repo) rule.repo = repo;
  if (org) rule.org = org;
  if (prefix) rule.prefix = prefix;
  const brain = str(r.brain);
  if (brain) rule.brain = brain;
  if (r.deny === true) rule.deny = true;
  const remote = str(r.remote);
  if (remote) rule.remote = remote;
  if (r.origin === "local" || r.origin === "shared") rule.origin = r.origin;
  return rule;
}

/**
 * Parse a `defaultBrain` / brain-pointer field that may be a bare string (`"~/brain"`) or a
 * `{ brain, remote }` object. Returns a {@link ResolvedBrain} (path kept as-written, expanded by
 * callers) or null when nothing usable is present. Never throws.
 */
function parseResolvedBrainField(raw: unknown): ResolvedBrain | null {
  if (typeof raw === "string" && raw.length > 0) return { brain: raw };
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (typeof o.brain === "string" && o.brain.length > 0) {
      const rb: ResolvedBrain = { brain: o.brain };
      if (typeof o.remote === "string" && o.remote.length > 0) rb.remote = o.remote;
      return rb;
    }
  }
  return null;
}

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
  const registry: Registry = {};

  // Parse the unified ruleset (ADR-0024) with the same defensive discipline: skip any malformed
  // rule rather than throwing, so a partial hand-edit degrades to "fewer rules", never a crash.
  if (Array.isArray((obj as Registry).rules)) {
    const rules: Rule[] = [];
    for (const r of (obj as Registry).rules as unknown[]) {
      const rule = parseRule(r);
      if (rule) rules.push(rule);
    }
    if (rules.length > 0) registry.rules = rules;
  }
  // The default brain: a bare string (`"~/brain"`) or a `{ brain, remote }` object; anything else
  // is dropped.
  const defaultBrain = parseResolvedBrainField((obj as Registry).defaultBrain);
  if (defaultBrain) registry.defaultBrain = defaultBrain;

  // Parse the org-brain pointer with the same discipline: keep it only when `brain` is a
  // non-empty string; a malformed pointer is dropped (treated as "not designated") rather than
  // throwing, so a partial edit can never make resolution crash.
  const rawOrg = (obj as Registry).orgBrain;
  if (
    rawOrg &&
    typeof rawOrg === "object" &&
    typeof rawOrg.brain === "string" &&
    rawOrg.brain.length > 0
  ) {
    const org: ResolvedBrain = { brain: rawOrg.brain };
    if (typeof rawOrg.remote === "string" && rawOrg.remote.length > 0) org.remote = rawOrg.remote;
    registry.orgBrain = org;
  }
  // Legacy scope allow/deny (ADR-0008), read as sugar and folded into resolution (ADR-0024 §3/§7).
  // Kept as authored strings (tilde-expanded lazily at match time); only non-empty string entries
  // survive. These keys are owned by the scope CLI, never written by core writers.
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((e): e is string => typeof e === "string" && e.length > 0) : [];
  const allow = strList((obj as Registry).allow);
  if (allow.length > 0) registry.allow = allow;
  const deny = strList((obj as Registry).deny);
  if (deny.length > 0) registry.deny = deny;
  // Return the raw object too, so writers can round-trip keys they don't own (e.g. the scope
  // `allow`/`deny` that curate writes into the SAME config.json). ADR-0024 §6.
  return { status: "ok", registry, rawObj: obj as Record<string, unknown> };
}

/**
 * Parse the registry file into a normalized {@link Registry}; null on missing OR invalid. Used by
 * {@link resolveBrainDir}, which must never throw on a bad file — a corrupt registry simply
 * resolves no rules (resolution falls through to env). Writers use {@link readRegistryFile}
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
 * 3. The per-user config file (`opts.registryPath` ?? `$COMMONWEALTH_REGISTRY` ?? `$COMMONWEALTH_CONFIG`
 *    ?? `~/.commonwealth/config.json`): the most-specific matching rule → its `brain` (tilde-expanded).
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
 * Fold the legacy scope `allow`/`deny` lists (ADR-0008) into synthetic `prefix` rules so the single
 * {@link resolveBrain} pass IS the scope gate (ADR-0024 §3, retiring `isInScope`). A `deny` entry
 * becomes a `prefix` **deny** rule (→ `denied`); an `allow` entry becomes a bare-allow `prefix` rule
 * (→ the default brain, else `none`). They are **appended after** the authored {@link Registry.rules}
 * so an authored rule wins any exact-specificity tie (it is seen first) — a real `brain` route is
 * never shadowed by legacy sugar. Path expansion happens later in {@link scoreRule}.
 */
function scopeSugarRules(registry: Registry): Rule[] {
  const out: Rule[] = [];
  for (const d of registry.deny ?? []) out.push({ prefix: d, deny: true });
  for (const a of registry.allow ?? []) out.push({ prefix: a });
  return out;
}

/** Specificity tiers for rule matching (higher wins). Ties break by length, then deny-wins. */
const TIER_REPO = 4;
const TIER_ORG = 3;
const TIER_PREFIX = 2;
const TIER_STAR = 1;

/** True when any of a rule's matcher fields is the universal catch-all `"*"`. */
function isCatchAll(rule: Rule): boolean {
  return rule.repo === "*" || rule.org === "*" || rule.prefix === "*";
}

/**
 * Score how `rule` matches `(start, slug)`, or null if it doesn't. Returns the rule's
 * highest-tier matching matcher: catch-all < prefix < org < repo. `slug` is the cwd's git
 * identity ({@link resolveProjectSource}); null when the cwd isn't a repo (only path/catch-all
 * rules can then match). Pure.
 */
function scoreRule(
  rule: Rule,
  start: string,
  slug: string | null,
): { tier: number; len: number } | null {
  if (isCatchAll(rule)) return { tier: TIER_STAR, len: 0 };
  let tier = 0;
  let len = 0;
  if (rule.repo && slug && slug.toLowerCase() === rule.repo.toLowerCase()) {
    tier = TIER_REPO;
    len = rule.repo.length;
  }
  if (tier < TIER_ORG && rule.org) {
    const owner = rule.org.replace(/\/\*$/, "").toLowerCase();
    const slugOwner = slug && slug.includes("/") ? (slug.split("/")[0] ?? "").toLowerCase() : "";
    if (slugOwner && slugOwner === owner) {
      tier = TIER_ORG;
      len = owner.length;
    }
  }
  if (tier < TIER_PREFIX && rule.prefix) {
    const p = expand(rule.prefix);
    if (isUnder(start, p)) {
      tier = TIER_PREFIX;
      len = p.length;
    }
  }
  return tier > 0 ? { tier, len } : null;
}

/**
 * Evaluate the unified ruleset (ADR-0024) for `(start, slug)`. Returns:
 * - `null` when NO rule matched (caller falls through to the env layer);
 * - `{ kind: "denied" }` when the winning rule denies;
 * - `{ kind: "brain" }` when the winner routes (its `brain`, else the registry `defaultBrain`);
 * - `{ kind: "none" }` when a bare allow won but no `defaultBrain` is configured — a matched but
 *   undestined rule, which stops resolution (no env fallback) rather than capturing nowhere.
 *
 * Winner = the single most-specific matching rule (tier, then prefix length), with **deny winning
 * on an exact tie**. Pure.
 */
function matchRules(
  start: string,
  slug: string | null,
  rules: Rule[],
  defaultBrain: ResolvedBrain | null,
): BrainResolution | null {
  let best: { tier: number; len: number; rule: Rule } | null = null;
  for (const rule of rules) {
    const m = scoreRule(rule, start, slug);
    if (!m) continue;
    if (
      !best ||
      m.tier > best.tier ||
      (m.tier === best.tier && m.len > best.len) ||
      // exact specificity tie → deny wins over allow
      (m.tier === best.tier && m.len === best.len && rule.deny === true && best.rule.deny !== true)
    ) {
      best = { tier: m.tier, len: m.len, rule };
    }
  }
  if (!best) return null;
  const { rule } = best;
  if (rule.deny) return { kind: "denied" };
  if (rule.brain) {
    return {
      kind: "brain",
      brain: expand(rule.brain),
      ...(rule.remote ? { remote: rule.remote } : {}),
    };
  }
  // Bare allow → route to the default brain, if any. With none configured this is a matched-but-
  // undestined rule: resolve to `none` (a no-op) rather than silently falling back to the env brain.
  if (defaultBrain) {
    return {
      kind: "brain",
      brain: expand(defaultBrain.brain),
      ...(defaultBrain.remote ? { remote: defaultBrain.remote } : {}),
    };
  }
  return { kind: "none" };
}

/**
 * Resolve a working directory against the full model (ADR-0024), returning the three-way
 * {@link BrainResolution} — `brain` (in scope, routed), `denied` (an explicit deny rule; out of
 * scope), or `none` (nothing configured here). This is the scope-aware entry point the hooks
 * should use. Order (first hit wins):
 *
 * 1. `.commonwealth/brain` marker (nearest valid ancestor) — human override.
 * 2. A directory that is itself a brain (`.commonwealth/schema-version`).
 * 3. The unified ruleset ({@link Registry.rules}) — plus the legacy scope `allow`/`deny` folded in
 *    as sugar (ADR-0024 §3/§7) — most-specific match wins, deny breaks ties; a bare allow routes to
 *    `defaultBrain`. This pass is the scope gate: `denied` = out of scope, `none` = nothing here.
 * 4. `COMMONWEALTH_BRAIN_DIR` env fallback.
 * 5. `none`.
 *
 * The cwd's git identity is resolved once (and only when an identity rule is present), so
 * path-only registries never pay the git cost. Never throws on missing/unreadable files.
 */
export async function resolveBrain(
  startDir: string,
  opts: ResolveBrainOptions = {},
): Promise<BrainResolution> {
  const start = path.resolve(startDir);
  const registryPath = resolveRegistryPath(opts.registryPath);

  // 1) Explicit marker file, nearest ancestor wins — but only when its target actually exists.
  //    A dangling marker (brain moved/removed, or a stale one from older onboarding) is skipped so
  //    resolution falls through rather than being hijacked to a dead path (#68).
  for (const dir of walkUp(start)) {
    const raw = await readFileOrNull(path.join(dir, MARKER_REL));
    if (raw !== null) {
      const target = raw.trim();
      if (target.length > 0) {
        const resolved = expand(target, dir);
        if (await isDir(resolved)) return { kind: "brain", brain: resolved };
      }
    }
  }

  // 2) A directory that is itself a brain, nearest ancestor wins (keyed off `schema-version`).
  for (const dir of walkUp(start)) {
    if (await isFile(path.join(dir, BRAIN_IDENTITY_REL))) return { kind: "brain", brain: dir };
  }

  // 3) The unified ruleset, plus the legacy scope allow/deny folded in as sugar (ADR-0024 §3/§7):
  //    this single pass IS the scope gate now that `isInScope` is retired.
  const registry = await loadRegistry(registryPath);
  const rules = registry ? [...(registry.rules ?? []), ...scopeSugarRules(registry)] : [];
  if (rules.length > 0) {
    // Resolve git identity once, only if an identity rule could use it (path-only stays cheap).
    const needsSlug = rules.some((r) => (r.repo && r.repo !== "*") || (r.org && r.org !== "*"));
    const slug = needsSlug ? await resolveProjectSource(start) : null;
    const result = matchRules(start, slug, rules, registry?.defaultBrain ?? null);
    if (result) return result;
  }

  // 4) Env fallback.
  const env = opts.env ?? process.env.COMMONWEALTH_BRAIN_DIR;
  if (env && env.length > 0) return { kind: "brain", brain: path.resolve(env) };

  // 5) Nothing matched.
  return { kind: "none" };
}

/**
 * Like {@link resolveBrainDir}, but returns the full {@link ResolvedBrain} — the brain path AND
 * the git `remote` to clone from when it came from a registry mapping (ADR-0019). A thin wrapper
 * over {@link resolveBrain}: both `denied` and `none` collapse to `null` (no brain), preserving
 * the pre-ADR-0024 contract for callers that only care "which brain, if any". Callers that must
 * distinguish an explicit deny from an unmapped dir (the scope gate) use {@link resolveBrain}.
 * Still side-effect-free: it never clones — that is the caller's explicit act.
 */
export async function resolveBrainMapping(
  startDir: string,
  opts: ResolveBrainOptions = {},
): Promise<ResolvedBrain | null> {
  const result = await resolveBrain(startDir, opts);
  if (result.kind !== "brain") return null;
  return { brain: result.brain, ...(result.remote ? { remote: result.remote } : {}) };
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
 * The default per-user config path (public wrapper over the internal resolver): honors
 * `$COMMONWEALTH_REGISTRY`, then `$COMMONWEALTH_CONFIG`, then `~/.commonwealth/config.json`.
 * This is where onboarding writes the routing rules (resolution layer 3, the default source of
 * truth).
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
 * Load, guard-against-corrupt, mutate, and atomically persist the registry. Centralizes the
 * "never silently overwrite a corrupt registry" discipline (#78) shared by every writer: a
 * present-but-unparseable file is backed up to `registry.json.corrupt-<ts>` and a clear error is
 * thrown; a missing file starts from an empty registry. The `mutate` callback edits the registry
 * in place. Writes pretty JSON via tmp-file + rename so a crash mid-write leaves the prior file
 * intact.
 */
async function persistRegistry(
  registryPath: string,
  mutate: (registry: Registry) => void,
): Promise<void> {
  const load = await readRegistryFile(registryPath);
  if (load.status === "corrupt") {
    const backup = `${registryPath}.corrupt-${Date.now()}`;
    await fs.rename(registryPath, backup).catch(() => fs.writeFile(backup, load.raw, "utf8"));
    throw new Error(
      `Refusing to overwrite a corrupt registry at ${registryPath} (backed up to ${backup}). ` +
        `Fix or remove it, then retry.`,
    );
  }
  const registry: Registry = load.status === "ok" ? load.registry : {};
  mutate(registry);
  // Merge our managed keys back onto the raw object so keys we don't own — notably the scope
  // `allow`/`deny` that curate writes into the SAME config.json (ADR-0024 §6) — survive the write.
  const out: Record<string, unknown> = load.status === "ok" ? { ...load.rawObj } : {};
  const sync = (key: keyof Registry) => {
    if (registry[key] === undefined) delete out[key];
    else out[key] = registry[key];
  };
  sync("rules");
  sync("defaultBrain");
  sync("orgBrain");
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  const tmp = `${registryPath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  await fs.rename(tmp, registryPath);
}

/**
 * List every wired project-brain directory (expanded, absolute), de-duplicated by absolute path so
 * two checkouts of the same repo count once. Fills the "list *all* brains" gap — resolution only
 * ever answered "which brain for *this* dir" before (#167). The org-brain (when designated) is
 * excluded: it is the graduation *target*, not a project brain to scan. Returns `[]` on a missing
 * or corrupt registry — never throws (a bad file simply lists no brains).
 */
export async function listWiredBrainDirs(opts: { registryPath?: string } = {}): Promise<string[]> {
  const registry = await loadRegistry(resolveRegistryPath(opts.registryPath));
  if (!registry) return [];
  const orgDir = registry.orgBrain ? expand(registry.orgBrain.brain) : null;
  const seen = new Set<string>();
  const dirs: string[] = [];
  // Every brain a rule routes to, plus the default brain a bare allow uses. Deny rules (no brain)
  // contribute nothing; the org-brain (graduation target) is excluded.
  const brains = [
    ...(registry.rules ?? []).map((r) => r.brain).filter((b): b is string => typeof b === "string"),
    ...(registry.defaultBrain ? [registry.defaultBrain.brain] : []),
  ];
  for (const b of brains) {
    const dir = expand(b);
    if (dir === orgDir || seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  return dirs;
}

/**
 * Read the designated org-brain (ADR-0023), with its `brain` path expanded to absolute and any
 * clone-on-demand `remote` carried through (ADR-0019). `null` when none is designated, or on a
 * missing/corrupt registry. Never throws.
 */
export async function getOrgBrain(
  opts: { registryPath?: string } = {},
): Promise<ResolvedBrain | null> {
  const registry = await loadRegistry(resolveRegistryPath(opts.registryPath));
  if (!registry?.orgBrain) return null;
  const org: ResolvedBrain = { brain: expand(registry.orgBrain.brain) };
  if (registry.orgBrain.remote) org.remote = registry.orgBrain.remote;
  return org;
}

/**
 * Designate `brain` as this user's org-brain (ADR-0023, #167). `brain` is `~`-expanded and resolved
 * to an absolute path; an optional `remote` records where to clone it from on demand (ADR-0019).
 * Idempotent overwrite of any prior pointer. Same safety as {@link addRule}: refuses to
 * clobber a corrupt registry, persists atomically. Preserves existing `rules`.
 */
export async function setOrgBrain(
  brain: string,
  opts: { remote?: string; registryPath?: string } = {},
): Promise<void> {
  const registryPath = opts.registryPath ?? defaultRegistryPath();
  const org: ResolvedBrain = { brain: expand(brain) };
  if (opts.remote) org.remote = opts.remote;
  await persistRegistry(registryPath, (registry) => {
    registry.orgBrain = org;
  });
}

/**
 * A rule's canonical matcher key — used to dedupe rules by "what they match" (ignoring their
 * outcome). Two rules with the same key target the same repo/org/path, so a writer updates in
 * place rather than appending a duplicate. Catch-all (`"*"` in any matcher) canonicalizes to
 * `"*"`. `null` when the rule has no matcher. Case-insensitive for identity; prefixes expand.
 */
export function ruleMatcherKey(rule: Rule): string | null {
  if (isCatchAll(rule)) return "*";
  if (rule.repo) return `repo:${rule.repo.toLowerCase()}`;
  if (rule.org) return `org:${rule.org.replace(/\/\*$/, "").toLowerCase()}`;
  if (rule.prefix) return `prefix:${expand(rule.prefix)}`;
  return null;
}

/** Normalize a rule for storage: expand path-ish fields to absolute; keep identity as written. */
function normalizeRuleForStore(rule: Rule): Rule {
  const out: Rule = {};
  if (rule.repo) out.repo = rule.repo;
  if (rule.org) out.org = rule.org;
  if (rule.prefix) out.prefix = rule.prefix === "*" ? "*" : expand(rule.prefix);
  if (rule.brain) out.brain = expand(rule.brain);
  if (rule.deny) out.deny = true;
  if (rule.remote) out.remote = rule.remote;
  if (rule.origin) out.origin = rule.origin;
  return out;
}

/**
 * Add or update a rule in the unified ruleset (ADR-0024). Dedupe is by {@link ruleMatcherKey}: a
 * rule with the same matcher has its outcome (brain / deny / remote) replaced in place; otherwise
 * the rule is appended. Path-ish fields are expanded to absolute; identity matchers are kept as
 * written (matching is case-insensitive). Durable: atomic write, refuse-to-clobber-corrupt. Throws
 * if the rule has no matcher.
 */
export async function addRule(
  rule: Rule,
  opts: { registryPath?: string } = {},
): Promise<{ added: boolean; updated: boolean }> {
  const registryPath = opts.registryPath ?? defaultRegistryPath();
  const key = ruleMatcherKey(rule);
  if (!key) throw new Error("a rule needs a matcher: one of repo, org, or prefix");
  const normalized = normalizeRuleForStore(rule);
  let added = false;
  let updated = false;
  await persistRegistry(registryPath, (registry) => {
    if (!registry.rules) registry.rules = [];
    const idx = registry.rules.findIndex((r) => ruleMatcherKey(r) === key);
    if (idx === -1) {
      registry.rules.push(normalized);
      added = true;
    } else if (JSON.stringify(registry.rules[idx]) !== JSON.stringify(normalized)) {
      registry.rules[idx] = normalized;
      updated = true;
    }
  });
  return { added, updated };
}

/**
 * Remove every rule whose matcher equals `matcher`'s (by {@link ruleMatcherKey}). Returns the count
 * removed (0 when none matched). `matcher` need only carry the matcher fields (repo/org/prefix).
 * Atomic, refuse-to-clobber-corrupt.
 */
export async function removeRule(
  matcher: Rule,
  opts: { registryPath?: string } = {},
): Promise<{ removed: number }> {
  const registryPath = opts.registryPath ?? defaultRegistryPath();
  const key = ruleMatcherKey(matcher);
  if (!key) throw new Error("a matcher is required: one of repo, org, or prefix");
  let removed = 0;
  await persistRegistry(registryPath, (registry) => {
    if (!registry.rules) return;
    const before = registry.rules.length;
    registry.rules = registry.rules.filter((r) => ruleMatcherKey(r) !== key);
    removed = before - registry.rules.length;
  });
  return { removed };
}

/**
 * Set (or clear) the registry's {@link Registry.defaultBrain} — the brain a bare-allow rule routes
 * to (ADR-0024 §4). Pass a brain path (`~`-expanded) with an optional clone-on-demand `remote`, or
 * `null` to clear it. Atomic, refuse-to-clobber-corrupt.
 */
export async function setDefaultBrain(
  brain: string | null,
  opts: { remote?: string; registryPath?: string } = {},
): Promise<void> {
  const registryPath = opts.registryPath ?? defaultRegistryPath();
  await persistRegistry(registryPath, (registry) => {
    if (brain === null) {
      delete registry.defaultBrain;
      return;
    }
    const rb: ResolvedBrain = { brain: expand(brain) };
    if (opts.remote) rb.remote = opts.remote;
    registry.defaultBrain = rb;
  });
}

/** Read the full per-user config (rules, defaultBrain, orgBrain); `null` if missing/corrupt. */
export async function loadRegistryFile(
  opts: { registryPath?: string } = {},
): Promise<Registry | null> {
  return loadRegistry(resolveRegistryPath(opts.registryPath));
}

/**
 * Wire a folder to a brain (ADR-0024): write an **identity** rule (`repo:<owner/repo>`) when the
 * folder is a git repo with an `origin` — so the mapping follows that repo across worktrees, clones,
 * and machines — else a **path** rule (`prefix:<folder>`). This is the write half of the
 * onboarding/`commonwealth add` flow. Returns the add result plus the rule that was written.
 */
export async function wireFolder(
  folder: string,
  brain: string,
  opts: { remote?: string; registryPath?: string } = {},
): Promise<{ added: boolean; updated: boolean; rule: Rule }> {
  const slug = await repoIdentity(folder);
  const rule: Rule = slug
    ? { repo: slug, brain, ...(opts.remote ? { remote: opts.remote } : {}) }
    : { prefix: folder, brain, ...(opts.remote ? { remote: opts.remote } : {}) };
  const res = await addRule(rule, { registryPath: opts.registryPath });
  return { ...res, rule };
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
