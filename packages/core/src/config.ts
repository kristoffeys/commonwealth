import { promises as fs } from "node:fs";
import path from "node:path";
import type { EmbeddingsConfig } from "./embed.js";
import type { Rule } from "./registry.js";
import { SCHEMA_VERSION } from "./schema.js";
import type { ScanOptions } from "./secrets.js";

/**
 * Brain-level (shared, synced) configuration, stored at `<brain>/.commonwealth/config.json`
 * (ADR-0009). Distinct from the per-user, unsynced scope config at `~/.commonwealth/config.json`
 * (ADR-0008). Because it lives in the repo, `features` apply to the whole team.
 */
export interface BrainConfig {
  /** Human-readable brain name (defaults to the brain directory's basename). */
  name: string;
  /** On-disk schema version this brain is pinned to. */
  schemaVersion: number;
  /** Configured git remotes for sync (names or URLs). */
  remotes: string[];
  /** Free-form curation settings, reserved for the curator seam (ADR-0007). */
  curation: Record<string, unknown>;
  /** Team-wide feature toggles; see {@link FEATURE_FLAGS}. */
  features: Record<string, boolean>;
  /**
   * Secret-scanner tuning (#46), committed so it applies team-wide. `entropy` opts into
   * high-entropy detection beyond the named patterns; `allowlist` holds accepted values /
   * known false positives to suppress. Off + empty by default (preserves the zero-FP default).
   */
  secretScan: { entropy: boolean; allowlist: string[] };
  /**
   * Embeddings settings for semantic dedup (ADR-0021). Inert unless the `semanticDedup` feature
   * flag is on; then `provider` picks how vectors are produced (`local` on-machine by default,
   * `hosted` opt-in, `none` to disable). See {@link EmbeddingsConfig}.
   */
  embeddings: EmbeddingsConfig;
  /**
   * **Shared** brain-resolution rules (ADR-0024 §5): the `origin: "shared"` half of the ruleset,
   * committed here so it syncs to the whole team. Each entry is a **matcher only** (`repo` / `org`
   * / `prefix`) plus an optional `deny` — it carries NO brain path (a route means "capture into
   * THIS brain, wherever each teammate has it cloned") and NO `origin`/`remote` (those are
   * per-machine). On sync each teammate's {@link importSharedRules} materializes these into their
   * per-user `~/.commonwealth/config.json` as `origin: "shared"` rules; a teammate's own `local`
   * rule for the same matcher overrides. Personal `local` denies never land here. Defaults to `[]`.
   */
  sharedRules: Rule[];
}

/**
 * Validate one raw **shared** rule (ADR-0024 §5): a matcher (`repo` / `org` / `prefix`) plus an
 * optional `deny`, and nothing else — a shared rule never carries a brain path, `origin`, or
 * `remote` (all per-machine). Returns a clean {@link Rule} or null for a matcher-less / malformed
 * entry, so a partial hand-edit degrades to "fewer shared rules" rather than throwing.
 */
export function parseSharedRule(raw: unknown): Rule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;
  const repo = str(r.repo);
  const org = str(r.org);
  const prefix = str(r.prefix);
  if (!repo && !org && !prefix) return null;
  const out: Rule = {};
  if (repo) out.repo = repo;
  if (org) out.org = org;
  if (prefix) out.prefix = prefix;
  if (r.deny === true) out.deny = true;
  return out;
}

/** Build the {@link ScanOptions} for the secret scanner from a brain's config (#46). */
export function scanOptions(config: BrainConfig): ScanOptions {
  return { detectEntropy: config.secretScan.entropy, allowlist: config.secretScan.allowlist };
}

/**
 * Registry of the known feature flags: their name, a human-readable description, and the
 * default (off unless a team opts in). New flags are added here; scaffold and
 * {@link defaultBrainConfig} build the `features` block from this list.
 */
export const FEATURE_FLAGS: ReadonlyArray<{
  name: string;
  description: string;
  default: boolean;
}> = [
  {
    name: "autoAdr",
    description:
      "Record decision notes in the brain — both auto-detected decisions from a session and " +
      "explicit ones logged via /commonwealth:decide. Default ON so every team keeps a trace of " +
      "what was decided, when, by whom, and why. Set false to stop capturing decision notes in " +
      "this brain entirely.",
    default: true,
  },
  {
    name: "autoPromote",
    description:
      "Auto-promote captured notes straight into canon instead of holding them in the review " +
      "queue. Curation gating (dedup/validation) still applies; only the manual review step is " +
      "skipped (ADR-0014). Set false to require manual /commonwealth:promote.",
    default: true,
  },
  {
    name: "semanticDedup",
    description:
      "Embeddings-backed semantic dedup in the curation gate (ADR-0021): catch near-duplicate " +
      "notes phrased differently, alongside the lexical check. Off by default; when on, uses the " +
      "embeddings.provider (local on-machine by default). Enabling `local` needs the optional " +
      "model package installed on the host.",
    default: false,
  },
  {
    name: "semanticSearch",
    description:
      "Hybrid semantic retrieval in search() when an embeddings provider is configured (ADR-0025, " +
      "reusing the ADR-0021 vectors): rank query embeddings alongside the lexical BM25 list and " +
      "fuse them, so ask/recall/search/injection become paraphrase-proof. Default ON, but inert " +
      "unless embeddings.provider resolves — so unconfigured brains are unchanged; set false to " +
      "force lexical-only even with a provider.",
    default: true,
  },
];

/** Default embeddings config (ADR-0021): local provider, inert until `semanticDedup` is on. */
export function defaultEmbeddingsConfig(): EmbeddingsConfig {
  return { provider: "local", threshold: 0.85 };
}

/** Build the default `features` map from {@link FEATURE_FLAGS} (each flag at its default). */
function defaultFeatures(): Record<string, boolean> {
  const features: Record<string, boolean> = {};
  for (const flag of FEATURE_FLAGS) {
    features[flag.name] = flag.default;
  }
  return features;
}

/**
 * A fresh {@link BrainConfig} for a brain named `name`: no remotes, empty curation, and the
 * `features` block filled from {@link FEATURE_FLAGS} defaults. Pinned to `SCHEMA_VERSION`.
 */
export function defaultBrainConfig(name: string): BrainConfig {
  return {
    name,
    schemaVersion: SCHEMA_VERSION,
    remotes: [],
    curation: {},
    features: defaultFeatures(),
    secretScan: { entropy: false, allowlist: [] },
    embeddings: defaultEmbeddingsConfig(),
    sharedRules: [],
  };
}

/** Brains already warned about a schema skew this process, so the warning fires once each. */
const schemaSkewWarned = new Set<string>();

/** Warn (once per brain per process) that the on-disk config is a newer schema than this code. */
function warnSchemaSkewOnce(brainDir: string, found: number): void {
  const key = path.resolve(brainDir);
  if (schemaSkewWarned.has(key)) return;
  schemaSkewWarned.add(key);
  console.error(
    `[commonwealth] brain at ${key} is schema v${found} but this build understands v${SCHEMA_VERSION}; ` +
      `some fields may not be read correctly — upgrade Commonwealth.`,
  );
}

/** Path of the brain config relative to the brain root. */
const CONFIG_REL = path.join(".commonwealth", "config.json");

/** Absolute path to a brain's shared config file (`<brainDir>/.commonwealth/config.json`). */
export function brainConfigPath(brainDir: string): string {
  return path.join(brainDir, CONFIG_REL);
}

/**
 * Load a brain's shared config, merged over {@link defaultBrainConfig} so any missing
 * top-level field AND any missing feature key is filled in (file values win; unknown
 * feature keys present in the file are preserved). Never throws on a missing or unparseable
 * file — returns the defaults in that case.
 */
export async function loadBrainConfig(brainDir: string): Promise<BrainConfig> {
  const defaults = defaultBrainConfig(path.basename(path.resolve(brainDir)));

  let raw: string;
  try {
    raw = await fs.readFile(brainConfigPath(brainDir), "utf8");
  } catch {
    return defaults;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaults;
  }

  const obj = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Partial<BrainConfig>;

  // Detect a brain written by a NEWER schema than this code understands (#101): silently
  // proceeding could mis-read forward-version fields. Warn once per brain rather than throw —
  // the config still loads best-effort — so a version skew is at least visible.
  if (typeof obj.schemaVersion === "number" && obj.schemaVersion > SCHEMA_VERSION) {
    warnSchemaSkewOnce(brainDir, obj.schemaVersion);
  }

  return {
    name: typeof obj.name === "string" ? obj.name : defaults.name,
    schemaVersion:
      typeof obj.schemaVersion === "number" ? obj.schemaVersion : defaults.schemaVersion,
    remotes: Array.isArray(obj.remotes) ? obj.remotes : defaults.remotes,
    curation:
      typeof obj.curation === "object" && obj.curation !== null ? obj.curation : defaults.curation,
    // Defaults first so missing flags are filled; file values win, unknown keys preserved.
    features: {
      ...defaults.features,
      ...(typeof obj.features === "object" && obj.features !== null ? obj.features : {}),
    },
    secretScan: normalizeSecretScan(obj.secretScan, defaults.secretScan),
    embeddings: normalizeEmbeddings(obj.embeddings, defaults.embeddings),
    // Shared rules (ADR-0024 §5): keep only well-formed matcher(+deny) entries; a malformed one is
    // dropped rather than throwing (mirrors the per-user ruleset's defensive parse).
    sharedRules: Array.isArray(obj.sharedRules)
      ? obj.sharedRules.map(parseSharedRule).filter((r): r is Rule => r !== null)
      : defaults.sharedRules,
  };
}

/** Coerce a config file's `embeddings` block into the typed shape, falling back per field. */
function normalizeEmbeddings(raw: unknown, fallback: EmbeddingsConfig): EmbeddingsConfig {
  if (typeof raw !== "object" || raw === null) return fallback;
  const obj = raw as Partial<EmbeddingsConfig>;
  const provider =
    obj.provider === "none" || obj.provider === "local" || obj.provider === "hosted"
      ? obj.provider
      : fallback.provider;
  const threshold =
    typeof obj.threshold === "number" && Number.isFinite(obj.threshold)
      ? obj.threshold
      : fallback.threshold;
  return {
    provider,
    threshold,
    ...(typeof obj.model === "string" ? { model: obj.model } : {}),
    ...(typeof obj.endpoint === "string" ? { endpoint: obj.endpoint } : {}),
    ...(typeof obj.apiKeyEnv === "string" ? { apiKeyEnv: obj.apiKeyEnv } : {}),
  };
}

/** Coerce a config file's `secretScan` into the typed shape, falling back to defaults per field. */
function normalizeSecretScan(
  raw: unknown,
  fallback: BrainConfig["secretScan"],
): BrainConfig["secretScan"] {
  if (typeof raw !== "object" || raw === null) return fallback;
  const obj = raw as Partial<BrainConfig["secretScan"]>;
  return {
    entropy: typeof obj.entropy === "boolean" ? obj.entropy : fallback.entropy,
    allowlist:
      Array.isArray(obj.allowlist) && obj.allowlist.every((v) => typeof v === "string")
        ? obj.allowlist
        : fallback.allowlist,
  };
}

/**
 * Persist a brain's shared config as pretty (2-space) JSON with a trailing newline at
 * {@link brainConfigPath}, creating the `.commonwealth/` parent directory if needed.
 */
export async function saveBrainConfig(brainDir: string, config: BrainConfig): Promise<void> {
  const file = brainConfigPath(brainDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Atomic write (tmp + rename): a crash mid-write must not leave a torn config.json, which
  // `loadBrainConfig` would fail to parse and silently replace with defaults — flipping
  // team settings like `autoPromote` back on (#101). Rename is atomic on the same filesystem.
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

/**
 * True when `feature` is enabled in the brain's shared config. Unknown or unset flags are
 * treated as disabled (`false`). Never throws on a missing config file.
 */
export async function isFeatureEnabled(brainDir: string, feature: string): Promise<boolean> {
  const config = await loadBrainConfig(brainDir);
  return Boolean(config.features[feature]);
}

/**
 * Set `feature` to `on` in the brain's shared config and persist it (load-modify-save).
 * Missing top-level fields and feature keys are filled from defaults on the way through.
 */
export async function setFeature(brainDir: string, feature: string, on: boolean): Promise<void> {
  const config = await loadBrainConfig(brainDir);
  config.features[feature] = on;
  await saveBrainConfig(brainDir, config);
}
