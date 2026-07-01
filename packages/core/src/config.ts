import { promises as fs } from "node:fs";
import path from "node:path";
import { SCHEMA_VERSION } from "./schema.js";

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
    description: "Auto-create ADR/decision notes in the brain when a decision is captured",
    default: false,
  },
];

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
  };
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
  };
}

/**
 * Persist a brain's shared config as pretty (2-space) JSON with a trailing newline at
 * {@link brainConfigPath}, creating the `.commonwealth/` parent directory if needed.
 */
export async function saveBrainConfig(brainDir: string, config: BrainConfig): Promise<void> {
  const file = brainConfigPath(brainDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
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
