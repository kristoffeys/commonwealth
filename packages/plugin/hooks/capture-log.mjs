import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Persistent capture log (#211). Every SessionEnd/PreCompact capture attempt appends ONE JSONL
// entry here so "why is my brain not filling?" has a durable, greppable answer — the detached
// capture worker's stdout goes nowhere (stdio: "ignore") and the deferred receipt is one-shot.
// `commonwealth doctor` and `commonwealth status` read the tail. Writing is best-effort and never
// throws: a broken log must never break capture.

/** Keep at most this many entries — a rolling window, not an audit trail. */
export const MAX_CAPTURE_LOG_ENTRIES = 500;
/** Hard byte cap so a pathological run of huge error strings can't grow the file without bound. */
export const MAX_CAPTURE_LOG_BYTES = 256 * 1024;

/**
 * Per-user path for the capture log. Honors `$COMMONWEALTH_CAPTURE_LOG`, then a `capture.log`
 * sibling of `$COMMONWEALTH_CONFIG` (so tests that redirect config also redirect the log), then
 * `~/.commonwealth/capture.log`. Mirrors the receipt path resolution so all per-user state
 * lives together.
 */
export function captureLogPath() {
  if (process.env.COMMONWEALTH_CAPTURE_LOG) return process.env.COMMONWEALTH_CAPTURE_LOG;
  if (process.env.COMMONWEALTH_CONFIG) {
    return path.join(path.dirname(process.env.COMMONWEALTH_CONFIG), "capture.log");
  }
  return path.join(os.homedir(), ".commonwealth", "capture.log");
}

/** Trim a child-process diagnostic to a one-line head short enough for a log entry / receipt. */
function headMessage(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.replace(/\s+/g, " ").trim().slice(0, 200) || null;
}

/**
 * Map a {@link sessionEnd} result to a structured capture-log entry. Pure — the caller supplies the
 * trusted session metadata (cwd/brain/host/boundary/ts) that the result object does not carry. The
 * `outcome` is the coarse machine state doctor/status branch on; `reason` names the specific failure
 * class or skip reason; the count fields describe a successful capture (including a legitimate
 * zero-capture that curation filtered as trivia/duplicate).
 *
 * @param {object} result   A sessionEnd outcome (skip / extractor-failure / curate-runtime / capture).
 * @param {{cwd?: string, brain?: string | null, host?: string | null, boundary?: string | null, ts?: number}} meta
 * @returns {object}        The JSONL entry.
 */
export function deriveCaptureLogEntry(result, meta = {}) {
  const base = {
    ts: typeof meta.ts === "number" ? meta.ts : Date.now(),
    cwd: typeof meta.cwd === "string" ? meta.cwd : null,
    brain: typeof meta.brain === "string" ? meta.brain : null,
    host: typeof meta.host === "string" ? meta.host : null,
    boundary: typeof meta.boundary === "string" ? meta.boundary : null,
  };
  if (!result || typeof result !== "object") {
    return { ...base, outcome: "skipped", reason: "unknown" };
  }
  if (result.skipped) {
    return { ...base, outcome: "skipped", reason: result.reason ?? "unknown" };
  }
  if (result.failed && result.reason === "extractor-failure") {
    return {
      ...base,
      outcome: "extraction-failed",
      // The specific ADR-0027 class (extractor-unavailable/timeout/failed/malformed-output) when the
      // extractor threaded it; else the coarse "extractor-failure".
      reason:
        typeof result.extractionReason === "string" ? result.extractionReason : "extractor-failure",
      code: typeof result.code === "number" ? result.code : null,
      timedOut: result.timedOut === true,
      error: headMessage(result.error),
    };
  }
  if (result.failed && result.reason === "curate-runtime") {
    return {
      ...base,
      outcome: "curate-failed",
      reason: "curate-runtime",
      code: typeof result.code === "number" ? result.code : null,
      error: headMessage(result.error),
    };
  }
  const captured = typeof result.captured === "number" ? result.captured : 0;
  const notes = Array.isArray(result.notes) ? result.notes : [];
  const promoted = notes.filter((n) => n && n.promoted).length;
  const staged = notes.length - promoted;
  const extracted =
    typeof result.extracted === "number" && result.extracted >= captured
      ? result.extracted
      : captured;
  return {
    ...base,
    outcome: "ok",
    extracted,
    captured,
    staged,
    promoted,
    rejected: Math.max(0, extracted - captured),
    // The LLM curation verdict summary (ADR-0030 / #237) — WHY candidates were dropped/merged.
    ...(result.verdicts && typeof result.verdicts === "object"
      ? { verdicts: result.verdicts }
      : {}),
    ...(result.syncDeferred ? { syncDeferred: true } : {}),
  };
}

/**
 * Append one entry to the capture log, then enforce the rolling caps (entry count AND byte size,
 * dropping oldest-first). Best-effort: any error is swallowed so a hook can never break on it.
 */
export async function appendCaptureLog(
  entry,
  {
    path: logPath = captureLogPath(),
    maxEntries = MAX_CAPTURE_LOG_ENTRIES,
    maxBytes = MAX_CAPTURE_LOG_BYTES,
  } = {},
) {
  try {
    let lines = [];
    try {
      const existing = await fs.readFile(logPath, "utf8");
      lines = existing.split("\n").filter((line) => line.trim().length > 0);
    } catch {
      // No log yet (or unreadable) — start fresh.
    }
    lines.push(JSON.stringify(entry));
    if (lines.length > maxEntries) lines = lines.slice(lines.length - maxEntries);
    // Byte cap: drop oldest lines until the serialized log fits.
    let body = lines.join("\n") + "\n";
    while (lines.length > 1 && Buffer.byteLength(body, "utf8") > maxBytes) {
      lines.shift();
      body = lines.join("\n") + "\n";
    }
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.writeFile(logPath, body, "utf8");
  } catch {
    // Non-fatal: a missing capture-log line is strictly better than a broken session.
  }
}

/**
 * Read and parse the capture log, newest entry LAST. Returns at most `limit` most-recent entries
 * (all of them when `limit` is omitted). Never throws — a missing/corrupt log reads as empty, and
 * individual unparseable lines are skipped.
 */
export async function readCaptureLog({ path: logPath = captureLogPath(), limit } = {}) {
  let raw;
  try {
    raw = await fs.readFile(logPath, "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Skip a corrupt line rather than losing the whole tail.
    }
  }
  if (typeof limit === "number" && limit > 0 && entries.length > limit) {
    return entries.slice(entries.length - limit);
  }
  return entries;
}
