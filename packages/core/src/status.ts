import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadBrainConfig } from "./config.js";
import { brainHealth } from "./health.js";
import { listNotes } from "./notes.js";

/**
 * Ambient brain-status cache (#197). Claude Code's `statusLine` renders a one-liner every turn, so
 * it must be well under ~100ms and do NO git/index work in that hot path. This module splits the
 * work: a WRITER (run off the hot path — the SessionEnd worker) computes the freshness score +
 * pending-review count and persists them to a small per-user cache; the statusline READER just
 * reads that cache and formats it. The cache is derived and disposable (ADR-0003) — losing it only
 * costs a slightly staler status line until the next session end refreshes it.
 */

/** One brain's cached status (what the statusline shows, minus the live sync check). */
export interface BrainStatus {
  /** Human-readable brain name (from `.commonwealth/config.json`, else the dir basename). */
  brain: string;
  /** Absolute brain directory — the cache key, echoed for the reader's convenience. */
  brainDir: string;
  /** Freshness/trust score 0–100 ({@link brainHealth}). */
  score: number;
  /** Total canonical notes. */
  total: number;
  /** Notes awaiting review in `staging/` — the nudge for `autoPromote:false` teams. */
  pending: number;
  /** Epoch ms the status was computed (staleness debugging). */
  ts: number;
}

/** The on-disk cache: a map keyed by absolute brain dir, so multi-brain users don't collide. */
export type StatusCache = Record<string, BrainStatus>;

/**
 * Path to the per-user status cache. Mirrors the registry/receipt resolution so all per-user state
 * lives together: `$COMMONWEALTH_STATUS` → a `status.json` sibling of `$COMMONWEALTH_CONFIG` (so
 * tests that redirect config also redirect the cache) → `~/.commonwealth/status.json`.
 */
export function statusCachePath(): string {
  if (process.env.COMMONWEALTH_STATUS) return process.env.COMMONWEALTH_STATUS;
  if (process.env.COMMONWEALTH_CONFIG) {
    return path.join(path.dirname(process.env.COMMONWEALTH_CONFIG), "status.json");
  }
  return path.join(os.homedir(), ".commonwealth", "status.json");
}

/** Count notes staged for review under `<brain>/staging` (curate's review queue). */
async function pendingCount(brainDir: string): Promise<number> {
  // Staged notes are ordinary notes rooted at `staging/` (ADR-0007); `listNotes` on that subtree
  // counts them. A missing staging dir yields 0 (listNotes never throws on absence).
  return (await listNotes(path.join(brainDir, "staging"))).length;
}

/**
 * Compute a brain's status from its files. This does the index work ({@link brainHealth} lists +
 * parses every note), so it belongs OFF the statusline hot path — the writer calls it, not the
 * reader. Read-only; never writes canon (ADR-0003).
 */
export async function computeBrainStatus(brainDir: string, now: number): Promise<BrainStatus> {
  const notes = await listNotes(brainDir);
  const { score, total } = brainHealth(notes);
  let brain = path.basename(brainDir);
  try {
    brain = (await loadBrainConfig(brainDir)).name || brain;
  } catch {
    // Missing/unreadable config → fall back to the directory basename.
  }
  const pending = await pendingCount(brainDir);
  return { brain, brainDir, score, total, pending, ts: now };
}

/** Read the status cache, or an empty map if it is absent/unreadable. Never throws. */
export async function readStatusCache(): Promise<StatusCache> {
  try {
    const parsed = JSON.parse(await fs.readFile(statusCachePath(), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as StatusCache) : {};
  } catch {
    return {};
  }
}

/**
 * Merge one brain's status into the cache and persist it atomically (tmp + rename). Best-effort:
 * the cache is disposable, so a write failure is swallowed rather than allowed to break the caller
 * (a hook must never break the session). Keyed by brain dir so refreshing one brain leaves others
 * intact.
 */
export async function writeBrainStatus(status: BrainStatus): Promise<void> {
  try {
    const cache = await readStatusCache();
    cache[status.brainDir] = status;
    const p = statusCachePath();
    await fs.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(cache), "utf8");
    await fs.rename(tmp, p);
  } catch {
    // Non-fatal: a stale/absent cache only costs a staler status line.
  }
}

/** Compute a brain's status and persist it to the cache. Returns the computed status. */
export async function refreshBrainStatus(brainDir: string, now: number): Promise<BrainStatus> {
  const status = await computeBrainStatus(brainDir, now);
  await writeBrainStatus(status);
  return status;
}

/** Inputs to {@link formatStatusLine}: the cached status (may be partial when cold) + live sync. */
export interface StatusLineInput {
  /** Brain name — always known (the reader resolves it from cwd even when the cache is cold). */
  brain: string;
  /** Cached rollup; `null`/absent when no session has refreshed this brain yet. */
  status?: BrainStatus | null;
  /** Whether a sync daemon is live for this brain (checked cheaply by the reader). */
  syncing?: boolean;
}

/**
 * Render the one-line status. Pure and allocation-light. Shape:
 *   `🧠 <brain> · <score>/100 · <pending> pending · ⇅`
 * Segments drop out gracefully: no cached rollup → just the name (+ sync); `pending: 0` is omitted
 * (nothing to nag about); sync only shows when the daemon is live. Never includes a trailing
 * newline — Claude Code handles that.
 */
export function formatStatusLine(input: StatusLineInput): string {
  const parts: string[] = [`🧠 ${input.brain}`];
  const s = input.status;
  if (s && typeof s.score === "number") parts.push(`${s.score}/100`);
  if (s && typeof s.pending === "number" && s.pending > 0) parts.push(`${s.pending} pending`);
  if (input.syncing) parts.push("⇅");
  return parts.join(" · ");
}
