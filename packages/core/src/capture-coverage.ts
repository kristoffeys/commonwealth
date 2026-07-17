import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Capture-coverage telemetry (#235). Built ON the persistent capture log written by the plugin
 * worker (`packages/plugin/hooks/capture-log.mjs` → `~/.commonwealth/capture.log`, JSONL): each
 * SessionEnd/PreCompact attempt appends one entry. This module is the pure, reader-side lens that
 * answers the trend question — "is capture healthy over time, and what fraction of my sessions
 * actually land knowledge?" — that individual failure receipts (#211) cannot. Measurement only:
 * it never changes capture behavior, and it never writes.
 *
 * The reader (`captureLogPath` / `readCaptureLog`) mirrors the writer's path resolution exactly so
 * both ends agree without importing across the package boundary (the plugin hooks run as standalone
 * `.mjs`). `packages/cli/src/capture-log.ts` re-exports these so there is a single TypeScript source
 * of truth for the log shape.
 */

/** One capture attempt, mirroring the writer's `deriveCaptureLogEntry` shape. */
export interface CaptureLogEntry {
  ts?: number;
  cwd?: string | null;
  /** Absolute path of the brain the session routed to (or null when none routed). */
  brain?: string | null;
  host?: string | null;
  boundary?: string | null;
  outcome: "ok" | "extraction-failed" | "curate-failed" | "skipped";
  reason?: string;
  extracted?: number;
  captured?: number;
  staged?: number;
  promoted?: number;
  rejected?: number;
  code?: number | null;
  timedOut?: boolean;
  error?: string | null;
  verdicts?: Record<string, number>;
}

/**
 * Resolve the capture-log path exactly as the plugin writer does: `$COMMONWEALTH_CAPTURE_LOG`, then
 * a `capture.log` sibling of `$COMMONWEALTH_CONFIG`, then `~/.commonwealth/capture.log`.
 */
export function captureLogPath(): string {
  if (process.env.COMMONWEALTH_CAPTURE_LOG) return process.env.COMMONWEALTH_CAPTURE_LOG;
  if (process.env.COMMONWEALTH_CONFIG) {
    return path.join(path.dirname(process.env.COMMONWEALTH_CONFIG), "capture.log");
  }
  return path.join(os.homedir(), ".commonwealth", "capture.log");
}

/** Read + parse the capture log, newest entry LAST. Never throws; skips corrupt lines. */
export async function readCaptureLog(logPath = captureLogPath()): Promise<CaptureLogEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(logPath, "utf8");
  } catch {
    return [];
  }
  const entries: CaptureLogEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as CaptureLogEntry;
      if (parsed && typeof parsed === "object" && typeof parsed.outcome === "string") {
        entries.push(parsed);
      }
    } catch {
      // Skip a corrupt line rather than losing the whole tail.
    }
  }
  return entries;
}

/** Trailing-day windows the coverage rollup reports on. */
export const COVERAGE_WINDOW_SHORT_DAYS = 7;
export const COVERAGE_WINDOW_LONG_DAYS = 30;

/** Milliseconds in a day. */
const DAY_MS = 86_400_000;

/** Ratio delta below which two windows count as "flat" (avoids arrow-flapping on noise). */
const TREND_EPSILON = 0.05;

/** True when an outcome represents an operational failure (as opposed to ok / a benign skip). */
export function isFailureOutcome(outcome: string): boolean {
  return outcome === "extraction-failed" || outcome === "curate-failed";
}

/** True when a successful capture actually landed at least one staged/promoted note. */
function isProductive(entry: CaptureLogEntry): boolean {
  if (entry.outcome !== "ok") return false;
  return (entry.staged ?? 0) + (entry.promoted ?? 0) >= 1;
}

/** Coverage over one trailing-day window. */
export interface CoverageWindow {
  /** The window length in days. */
  days: number;
  /**
   * Capture attempts that represent a real opportunity — every logged entry EXCEPT benign skips
   * (out-of-scope / boundary / nothing-new), which correctly decided there was nothing to do and
   * would only dilute the signal. Failures and zero-capture successes DO count.
   */
  seen: number;
  /** Of `seen`, how many landed ≥1 staged/promoted note. */
  productive: number;
  /** `productive / seen`, or null when `seen === 0` (cannot measure — never a failure). */
  ratio: number | null;
}

/** One failure class and how many times it occurred in the reporting window. */
export interface FailureClassCount {
  /** The specific failure class (`reason`, e.g. `extractor-timeout`), or the coarse outcome. */
  class: string;
  count: number;
}

/** Direction of the short-window ratio vs the immediately-prior short window. */
export type CoverageTrend = "up" | "down" | "flat" | "none";

/** The capture-coverage rollup for one brain (#235). */
export interface CaptureCoverage {
  /** True when there is at least one real capture opportunity in the long window. */
  hasData: boolean;
  /** Trailing {@link COVERAGE_WINDOW_SHORT_DAYS}-day window. */
  short: CoverageWindow;
  /** Trailing {@link COVERAGE_WINDOW_LONG_DAYS}-day window. */
  long: CoverageWindow;
  /** Short-window ratio vs the prior short window; "none" when either lacks data. */
  trend: CoverageTrend;
  /** Failure classes seen in the long window, most frequent first (ties broken alphabetically). */
  failures: FailureClassCount[];
  /** The most recent failure in the long window, or null when none. */
  lastFailure: { outcome: string; reason: string; ts?: number } | null;
}

/** Options for {@link captureCoverage}. */
export interface CoverageOptions {
  /**
   * Restrict counting to entries whose `brain` resolves to this directory — health runs per brain,
   * so a per-user log holding several brains' entries is filtered to just this one. When omitted,
   * every entry counts (used by whole-log views). Entries with no `brain` never match a specific dir.
   */
  brainDir?: string;
  /** "Now" in epoch ms; injectable for deterministic tests. Defaults to `Date.now()`. */
  now?: number;
}

/** True when `entry` belongs to `brainDir` (resolved-path equality); trivially true when no dir. */
function matchesBrain(entry: CaptureLogEntry, resolvedDir: string | null): boolean {
  if (resolvedDir === null) return true;
  if (typeof entry.brain !== "string" || entry.brain.length === 0) return false;
  return path.resolve(entry.brain) === resolvedDir;
}

/** Coverage over the entries whose ts falls in `[now - days*DAY, now]`. */
function windowFor(entries: CaptureLogEntry[], now: number, days: number): CoverageWindow {
  const floor = now - days * DAY_MS;
  let seen = 0;
  let productive = 0;
  for (const e of entries) {
    if (typeof e.ts !== "number" || e.ts < floor || e.ts > now) continue;
    if (e.outcome === "skipped") continue;
    seen += 1;
    if (isProductive(e)) productive += 1;
  }
  return { days, seen, productive, ratio: seen === 0 ? null : productive / seen };
}

/** Coverage over `[now - (days*2)*DAY, now - days*DAY)` — the window immediately before the short one. */
function priorWindowRatio(entries: CaptureLogEntry[], now: number, days: number): number | null {
  const upper = now - days * DAY_MS;
  const lower = now - 2 * days * DAY_MS;
  let seen = 0;
  let productive = 0;
  for (const e of entries) {
    if (typeof e.ts !== "number" || e.ts < lower || e.ts >= upper) continue;
    if (e.outcome === "skipped") continue;
    seen += 1;
    if (isProductive(e)) productive += 1;
  }
  return seen === 0 ? null : productive / seen;
}

/**
 * Compute the {@link CaptureCoverage} rollup for `entries` (as returned by {@link readCaptureLog},
 * newest last). Pure and read-only. Filters to `opts.brainDir` when given, then measures the
 * short/long trailing windows, the short-vs-prior trend, and the long-window failure-class
 * breakdown. An empty/absent log (or a brain with no entries) yields `hasData: false` and null
 * ratios — informational, never an error.
 */
export function captureCoverage(
  entries: CaptureLogEntry[],
  opts: CoverageOptions = {},
): CaptureCoverage {
  const now = typeof opts.now === "number" ? opts.now : Date.now();
  const resolvedDir = typeof opts.brainDir === "string" ? path.resolve(opts.brainDir) : null;
  const mine = entries.filter((e) => matchesBrain(e, resolvedDir));

  const short = windowFor(mine, now, COVERAGE_WINDOW_SHORT_DAYS);
  const long = windowFor(mine, now, COVERAGE_WINDOW_LONG_DAYS);

  // Trend: compare the short window's ratio against the window immediately before it. "none" unless
  // BOTH windows have data — a comparison against nothing is not a direction.
  const priorRatio = priorWindowRatio(mine, now, COVERAGE_WINDOW_SHORT_DAYS);
  let trend: CoverageTrend = "none";
  if (short.ratio !== null && priorRatio !== null) {
    const delta = short.ratio - priorRatio;
    trend = delta > TREND_EPSILON ? "up" : delta < -TREND_EPSILON ? "down" : "flat";
  }

  // Failure-class breakdown over the long window, plus the single most-recent failure.
  const longFloor = now - COVERAGE_WINDOW_LONG_DAYS * DAY_MS;
  const counts = new Map<string, number>();
  let lastFailure: CaptureCoverage["lastFailure"] = null;
  for (const e of mine) {
    if (typeof e.ts !== "number" || e.ts < longFloor || e.ts > now) continue;
    if (!isFailureOutcome(e.outcome)) continue;
    const cls = e.reason && e.reason.length > 0 ? e.reason : e.outcome;
    counts.set(cls, (counts.get(cls) ?? 0) + 1);
    // `mine` is newest-last, so the last failure we walk past is the most recent.
    lastFailure = { outcome: e.outcome, reason: e.reason ?? "", ts: e.ts };
  }
  const failures: FailureClassCount[] = [...counts.entries()]
    .map(([cls, count]) => ({ class: cls, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.class < b.class ? -1 : 1));

  return { hasData: long.seen > 0, short, long, trend, failures, lastFailure };
}
