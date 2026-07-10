import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A single user's scope configuration (the privacy gate). Personal project folders are kept out of
 * the brain by only capturing / injecting context for sessions whose cwd is in scope.
 *
 * As of ADR-0024 §3 the scope decision is no longer computed here: `@cmnwlth/core`'s `resolveBrain`
 * folds these `allow`/`deny` lists into its ruleset and returns a three-way result — `denied` (out
 * of scope), `none` (nothing configured here), or `brain` (in scope). This type + its IO remain the
 * readable **sugar** the `scope` CLI edits; `isInScope` is retired in favor of that single pass.
 */
export interface UserConfig {
  /** Absolute (tilde-allowed) roots that are in scope. Folded into resolution as bare-allow rules. */
  allow: string[];
  /** Absolute (tilde-allowed) roots that are always out of scope. Folded in as `deny` rules. */
  deny: string[];
}

/**
 * Resolve the user config path: `$COMMONWEALTH_CONFIG` if set, else `~/.commonwealth/config.json`.
 * The `COMMONWEALTH_CONFIG` override is essential so tests never touch the real `~/.commonwealth`.
 */
export function defaultConfigPath(): string {
  return process.env.COMMONWEALTH_CONFIG ?? path.join(os.homedir(), ".commonwealth", "config.json");
}

/**
 * Load and parse the user config. If the file is missing or partial, returns an empty
 * config (`{ allow: [], deny: [] }`), filling any missing arrays. Never throws on a
 * missing file.
 */
export async function loadUserConfig(configPath = defaultConfigPath()): Promise<UserConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    return { allow: [], deny: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { allow: [], deny: [] };
  }
  const obj = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Partial<UserConfig>;
  return {
    allow: Array.isArray(obj.allow) ? obj.allow : [],
    deny: Array.isArray(obj.deny) ? obj.deny : [],
  };
}

/**
 * Persist the scope `allow`/`deny` into the per-user config, **preserving any other keys** already
 * in the file — notably the brain-resolution `rules` / `defaultBrain` / `orgBrain` that
 * `@cmnwlth/core` writes into the SAME `~/.commonwealth/config.json` (ADR-0024 §6). Without this
 * merge, a scope write would clobber the routing rules and vice versa. Refuses to overwrite a
 * present-but-corrupt file (its bytes may be real wiring state); a missing file starts fresh.
 */
export async function saveUserConfig(
  config: UserConfig,
  configPath = defaultConfigPath(),
): Promise<void> {
  let existing: Record<string, unknown> = {};
  let raw: string | null = null;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    raw = null; // missing → start fresh
  }
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") existing = parsed as Record<string, unknown>;
    } catch {
      const backup = `${configPath}.corrupt-${Date.now()}`;
      await fs.rename(configPath, backup).catch(() => fs.writeFile(backup, raw as string, "utf8"));
      throw new Error(
        `Refusing to overwrite a corrupt config at ${configPath} (backed up to ${backup}). ` +
          `Fix or remove it, then retry.`,
      );
    }
  }
  const merged = { ...existing, allow: config.allow, deny: config.deny };
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}

/** Expand a leading `~` to the user's home directory, then resolve to an absolute path. */
function expand(entry: string): string {
  const home = os.homedir();
  if (entry === "~") return path.resolve(home);
  if (entry.startsWith("~/")) return path.resolve(home, entry.slice(2));
  return path.resolve(entry);
}

/**
 * Add a path to the `allow` list (tilde-expanded to an absolute path) if not already
 * present, then persist. Returns the resolved absolute path that was allowed, so callers
 * (the `scope allow` CLI command) can run follow-up checks against the entry as stored.
 */
export async function addAllow(pathArg: string, configPath = defaultConfigPath()): Promise<string> {
  const config = await loadUserConfig(configPath);
  const resolved = expand(pathArg);
  if (!config.allow.includes(resolved)) {
    config.allow.push(resolved);
    await saveUserConfig(config, configPath);
  }
  return resolved;
}

/**
 * Add a path to the `deny` list (tilde-expanded to an absolute path) if not already
 * present, then persist. Used by the `scope deny` CLI command.
 */
export async function addDeny(pathArg: string, configPath = defaultConfigPath()): Promise<void> {
  const config = await loadUserConfig(configPath);
  const resolved = expand(pathArg);
  if (!config.deny.includes(resolved)) {
    config.deny.push(resolved);
    await saveUserConfig(config, configPath);
  }
}
