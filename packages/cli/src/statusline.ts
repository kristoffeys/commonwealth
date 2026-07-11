import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type BrainStatus,
  formatStatusLine,
  readStatusCache,
  resolveBrain,
  type StatusCache,
} from "@cmnwlth/core";

/**
 * `commonwealth statusline` (#197) — the READ side of the ambient brain status line. Claude Code's
 * `statusLine` invokes this every turn with a JSON blob on stdin and renders our stdout, so it must
 * be well under ~100ms and do NO git/index work: it only resolves the brain for the cwd (a cheap
 * registry lookup), reads the pre-computed cache the SessionEnd worker maintains, and does a live
 * pidfile check for sync state. All heavy computation lives in the writer (`curate status-cache`).
 *
 * A plugin cannot register a main `statusLine` itself (Claude Code only honors `agent` /
 * `subagentStatusLine` from plugin settings), so enablement is a one-line addition to the user's
 * own `~/.claude/settings.json` — `install`/`uninstall` below wire it idempotently and safely.
 */

/** Pidfile a sync daemon writes for a brain. MIRRORS packages/sync/src/daemon.ts (keep in sync). */
const SYNC_PID_REL = path.join(".commonwealth", "sync.pid");

/**
 * True iff a sync daemon is live for `brainDir`: a recorded pid whose process still exists. Inlined
 * (rather than importing `@cmnwlth/sync`) so the hot-path statusline doesn't drag in chokidar and
 * the rest of the daemon at startup. Never throws.
 */
async function isSyncRunning(brainDir: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(brainDir, SYNC_PID_REL), "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(pid)) return false;
    process.kill(pid, 0); // signal 0 = existence check; throws ESRCH if the process is gone
    return true;
  } catch {
    return false;
  }
}

/** Injectable surfaces for {@link runStatusline} (defaults in {@link defaultStatuslineEnv}). */
export interface StatuslineEnv {
  /** The session's working directory (from the statusline stdin JSON). */
  cwd: string;
  /** Resolve the brain for a cwd (routing + scope). */
  resolveBrain: (cwd: string) => Promise<{ kind: string; brain?: string }>;
  /** Read the per-user status cache. */
  readCache: () => Promise<StatusCache>;
  /** Live sync-daemon check for a brain dir. */
  syncing: (brainDir: string) => Promise<boolean>;
}

/** Production surfaces: the real resolver, cache reader, and pidfile-based sync check. */
export function defaultStatuslineEnv(cwd: string): StatuslineEnv {
  return {
    cwd,
    resolveBrain: (c) => resolveBrain(c),
    readCache: () => readStatusCache(),
    syncing: (brainDir) => isSyncRunning(brainDir),
  };
}

/**
 * Render the one-line status for the session's cwd, or `""` when the cwd maps to no brain (an empty
 * statusline, not an error). Reads only the cache — a cwd whose brain has never been refreshed
 * still shows the brain name, degrading gracefully to `🧠 <name>` until the first SessionEnd warms
 * the cache. A broken per-user config file (#210) is the one exception to the empty-on-no-brain
 * rule: it renders a distinct, ambient warning so a hand-edit typo that has silently disabled
 * capture is visible every turn — not indistinguishable from "no brain here". Never throws.
 */
export async function runStatusline(env: StatuslineEnv): Promise<string> {
  const resolved = await env.resolveBrain(env.cwd);
  if (resolved.kind === "corrupt-config") return "🧠 ⚠ config unparseable — run `commonwealth doctor`";
  if (resolved.kind !== "brain" || !resolved.brain) return "";
  const brainDir = resolved.brain;
  const cache = await env.readCache();
  const status: BrainStatus | null = cache[brainDir] ?? null;
  const brain = status?.brain ?? path.basename(brainDir);
  const syncing = await env.syncing(brainDir);
  return formatStatusLine({ brain, status, syncing });
}

/** Default path of the user-scope Claude Code settings that hosts the `statusLine` entry. */
export function defaultClaudeSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

/** The command string we register — `commonwealth` is on PATH after the global npm install. */
export const STATUSLINE_COMMAND = "commonwealth statusline";

/** Outcome of {@link installStatusLine} / {@link uninstallStatusLine}. */
export type StatusLineInstallResult = "installed" | "already" | "conflict" | "removed" | "absent";

/**
 * Idempotently add our `statusLine` entry to a Claude Code `settings.json`, creating the file if
 * absent. Refuses to clobber a DIFFERENT existing `statusLine` (returns `"conflict"` so the caller
 * can tell the user to wire it by hand). Returns `"already"` when ours is present, `"installed"`
 * when newly written. Atomic (tmp + rename).
 */
export async function installStatusLine(
  settingsPath: string,
  command: string = STATUSLINE_COMMAND,
): Promise<StatusLineInstallResult> {
  const settings = await readJsonObject(settingsPath);
  const existing = settings.statusLine as { command?: unknown } | undefined;
  if (existing && typeof existing === "object") {
    if (existing.command === command) return "already";
    return "conflict";
  }
  settings.statusLine = { type: "command", command, padding: 0 };
  await writeJsonAtomic(settingsPath, settings);
  return "installed";
}

/**
 * Remove our `statusLine` entry from `settings.json`. Leaves a DIFFERENT statusLine untouched
 * (returns `"conflict"`); `"absent"` when there was none; `"removed"` when ours was deleted.
 */
export async function uninstallStatusLine(
  settingsPath: string,
  command: string = STATUSLINE_COMMAND,
): Promise<StatusLineInstallResult> {
  const settings = await readJsonObject(settingsPath);
  const existing = settings.statusLine as { command?: unknown } | undefined;
  if (!existing) return "absent";
  if (typeof existing !== "object" || existing.command !== command) return "conflict";
  delete settings.statusLine;
  await writeJsonAtomic(settingsPath, settings);
  return "removed";
}

/** Read a JSON object from `p`, or `{}` when it is absent/empty/unreadable. */
async function readJsonObject(p: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await fs.readFile(p, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Write `obj` as pretty JSON to `p` atomically, creating parent dirs. */
async function writeJsonAtomic(p: string, obj: unknown): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  await fs.rename(tmp, p);
}
