import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Reader-side view of the persistent capture log (#211). The plugin worker writes JSONL entries via
 * `packages/plugin/hooks/capture-log.mjs`; `commonwealth doctor` and `commonwealth status` read the
 * tail here. The path resolution mirrors the writer exactly so both ends agree without importing
 * across the package boundary (the plugin hooks run as standalone .mjs).
 */

/** One capture attempt, mirroring the writer's `deriveCaptureLogEntry` shape. */
export interface CaptureLogEntry {
  ts?: number;
  cwd?: string | null;
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

/** A coarse human age ("3h", "2d", "45m", "just now") for a capture timestamp. */
export function formatAge(ts: number | undefined, now = Date.now()): string {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "unknown time";
  const ms = Math.max(0, now - ts);
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** True when an outcome represents an operational failure (as opposed to ok / a benign skip). */
export function isFailureOutcome(outcome: string): boolean {
  return outcome === "extraction-failed" || outcome === "curate-failed";
}

/**
 * Count how many of the most-recent entries share the newest entry's failure class (outcome +
 * reason), scanning backwards from the tail. Returns `{ reason, count }` only when the newest entry
 * is a failure and the run is at least 2 long; otherwise null. Surfaces "last N captures all
 * extraction-timeout" streaks.
 */
export function failureStreak(
  entries: CaptureLogEntry[],
): { outcome: string; reason: string; count: number } | null {
  if (entries.length === 0) return null;
  const last = entries[entries.length - 1]!;
  if (!isFailureOutcome(last.outcome)) return null;
  const reason = last.reason ?? "";
  let count = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i]!;
    if (e.outcome === last.outcome && (e.reason ?? "") === reason) count += 1;
    else break;
  }
  return { outcome: last.outcome, reason, count };
}

/** One-line human summary of a single capture attempt (for `commonwealth status`). */
export function formatCaptureLine(entry: CaptureLogEntry, now = Date.now()): string {
  const when = formatAge(entry.ts, now);
  switch (entry.outcome) {
    case "ok": {
      const captured = entry.captured ?? 0;
      if (captured === 0) {
        const rej = entry.rejected ?? 0;
        const tail = rej > 0 ? ` (${rej} candidate(s) filtered by curation)` : "";
        return `Last capture (${when}): reviewed, captured nothing${tail}.`;
      }
      const parts: string[] = [];
      if (entry.promoted) parts.push(`${entry.promoted} promoted`);
      if (entry.staged) parts.push(`${entry.staged} staged`);
      const detail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
      return `Last capture (${when}): ✓ ${captured} note(s)${detail}.`;
    }
    case "extraction-failed":
      return `Last capture (${when}): ✗ extraction failed (${entry.reason ?? "unknown"}).`;
    case "curate-failed":
      return `Last capture (${when}): ✗ curate failed (${entry.reason ?? "unknown"}).`;
    case "skipped":
      return `Last capture (${when}): skipped (${entry.reason ?? "unknown"}).`;
    default:
      return `Last capture (${when}): ${entry.outcome}.`;
  }
}

/** The exact one-line fix hint for a capture failure class, or null when none applies. */
export function captureFixHint(reason: string): string | null {
  switch (reason) {
    case "extractor-unavailable":
      return "install/authenticate the host CLI (e.g. `claude /login`), then re-run `commonwealth doctor`";
    case "extractor-timeout":
      return "the extractor keeps timing out — check host CLI responsiveness and network";
    case "extractor-failed":
      return "the host extractor exited non-zero — expired auth is the usual cause (try `claude /login`)";
    case "malformed-output":
      return "the host returned schema-invalid output — update the host CLI / plugin (`commonwealth update`)";
    case "curate-runtime":
      return "the curate runtime failed — see the Curate runtime check";
    default:
      return null;
  }
}
