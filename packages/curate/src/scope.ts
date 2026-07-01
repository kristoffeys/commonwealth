import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A single user's scope configuration (the privacy gate). Personal project folders are
 * kept out of the brain by only capturing / injecting context for sessions whose cwd is
 * in scope. `deny` always wins over `allow`.
 */
export interface UserConfig {
  /** Absolute (tilde-allowed) roots that are in scope. Empty => everything is in scope. */
  allow: string[];
  /** Absolute (tilde-allowed) roots that are always out of scope. Wins over `allow`. */
  deny: string[];
}

/**
 * Resolve the user config path: `$COMMONS_CONFIG` if set, else `~/.commons/config.json`.
 * The `COMMONS_CONFIG` override is essential so tests never touch the real `~/.commons`.
 */
export function defaultConfigPath(): string {
  return process.env.COMMONS_CONFIG ?? path.join(os.homedir(), ".commons", "config.json");
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
 * Persist the user config as pretty JSON with a trailing newline, creating the parent
 * directory (`mkdir -p`) if needed.
 */
export async function saveUserConfig(
  config: UserConfig,
  configPath = defaultConfigPath(),
): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** Expand a leading `~` to the user's home directory, then resolve to an absolute path. */
function expand(entry: string): string {
  const home = os.homedir();
  if (entry === "~") return path.resolve(home);
  if (entry.startsWith("~/")) return path.resolve(home, entry.slice(2));
  return path.resolve(entry);
}

/**
 * True when `child` is the same path as `parent` or nested beneath it. Operates on
 * normalized absolute paths (no tilde expansion — callers pass expanded paths).
 */
function isUnder(child: string, parent: string): boolean {
  if (parent === path.sep) return true; // filesystem root contains everything
  return child === parent || child.startsWith(parent + path.sep);
}

/** True when `p` is under any entry in `list` (entries are tilde-expanded first). */
function underAny(p: string, list: string[]): boolean {
  return list.some((entry) => isUnder(p, expand(entry)));
}

/**
 * Decide whether `cwd` is in scope for a user's config. Rule (deny wins):
 * `inScope = (allow empty || cwd under some allow) && cwd not under any deny`.
 * The default (empty allow, empty deny) puts everything in scope.
 */
export function isInScope(cwd: string, config: UserConfig): boolean {
  const target = expand(cwd);
  const allowed = config.allow.length === 0 || underAny(target, config.allow);
  return allowed && !underAny(target, config.deny);
}

/**
 * Add a path to the `allow` list (tilde-expanded to an absolute path) if not already
 * present, then persist. Used by the `scope allow` CLI command.
 */
export async function addAllow(pathArg: string, configPath = defaultConfigPath()): Promise<void> {
  const config = await loadUserConfig(configPath);
  const resolved = expand(pathArg);
  if (!config.allow.includes(resolved)) {
    config.allow.push(resolved);
    await saveUserConfig(config, configPath);
  }
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
