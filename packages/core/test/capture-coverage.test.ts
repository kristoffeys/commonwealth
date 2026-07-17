import { describe, expect, it } from "vitest";
import {
  captureCoverage,
  type CaptureLogEntry,
  COVERAGE_WINDOW_SHORT_DAYS,
} from "../src/capture-coverage.js";

/**
 * Capture-coverage telemetry (#235). Pure rollup over the persistent capture log: trailing 7/30-day
 * windows, the short-vs-prior trend, the failure-class breakdown, and per-brain filtering. Fixed
 * `now` and hand-built log entries make the window math deterministic.
 */

const DAY = 86_400_000;
const NOW = Date.parse("2026-07-17T12:00:00Z");

/** Build a log entry `daysAgo` before NOW; `outcome`/counts default to a productive `ok`. */
function entry(daysAgo: number, over: Partial<CaptureLogEntry> = {}): CaptureLogEntry {
  return {
    ts: NOW - daysAgo * DAY,
    brain: "/brains/team",
    outcome: "ok",
    staged: 1,
    promoted: 0,
    ...over,
  };
}

const cov = (entries: CaptureLogEntry[], brainDir = "/brains/team") =>
  captureCoverage(entries, { brainDir, now: NOW });

describe("captureCoverage — windows", () => {
  it("empty/absent log is informational (hasData false, null ratios), never a failure", () => {
    const c = cov([]);
    expect(c.hasData).toBe(false);
    expect(c.short.ratio).toBeNull();
    expect(c.long.ratio).toBeNull();
    expect(c.short.seen).toBe(0);
    expect(c.failures).toEqual([]);
    expect(c.lastFailure).toBeNull();
    expect(c.trend).toBe("none");
  });

  it("counts productive sessions over 7/30-day windows; excludes benign skips from the denominator", () => {
    const c = cov([
      entry(1, { staged: 2 }), // productive, in 7d
      entry(2, { outcome: "ok", staged: 0, promoted: 0 }), // ok-but-zero, seen but not productive
      entry(3, { outcome: "skipped", reason: "out-of-scope" }), // benign skip → not seen
      entry(4, { outcome: "extraction-failed", reason: "extractor-timeout" }), // failure, seen
      entry(20, { staged: 1 }), // productive, in 30d only
    ]);
    // 7d: seen = 3 (2 ok + 1 failure; skip excluded), productive = 1.
    expect(c.short.seen).toBe(3);
    expect(c.short.productive).toBe(1);
    expect(c.short.ratio).toBeCloseTo(1 / 3, 5);
    // 30d: seen = 4, productive = 2.
    expect(c.long.seen).toBe(4);
    expect(c.long.productive).toBe(2);
    expect(c.long.ratio).toBeCloseTo(2 / 4, 5);
    expect(c.hasData).toBe(true);
  });

  it("drops entries older than the 30-day window entirely", () => {
    const c = cov([entry(45, { staged: 3 }), entry(2, { staged: 1 })]);
    expect(c.long.seen).toBe(1);
    expect(c.short.seen).toBe(1);
  });

  it("counts promoted-only captures as productive", () => {
    const c = cov([entry(1, { staged: 0, promoted: 2 })]);
    expect(c.short.productive).toBe(1);
    expect(c.short.ratio).toBe(1);
  });
});

describe("captureCoverage — trend", () => {
  const S = COVERAGE_WINDOW_SHORT_DAYS;

  it("reports 'up' when the recent window beats the prior window", () => {
    const c = cov([
      // prior 7d (days 7..14): 1 of 2 productive → 0.5
      entry(S + 1, { staged: 1 }),
      entry(S + 2, { outcome: "ok", staged: 0, promoted: 0 }),
      // recent 7d: 2 of 2 productive → 1.0
      entry(1, { staged: 1 }),
      entry(2, { staged: 1 }),
    ]);
    expect(c.trend).toBe("up");
  });

  it("reports 'down' when the recent window is worse than the prior window", () => {
    const c = cov([
      entry(S + 1, { staged: 1 }),
      entry(S + 2, { staged: 1 }),
      entry(1, { outcome: "extraction-failed", reason: "extractor-failed" }),
      entry(2, { staged: 1 }),
    ]);
    expect(c.trend).toBe("down");
  });

  it("reports 'none' when there is no prior window to compare against", () => {
    const c = cov([entry(1, { staged: 1 }), entry(2, { staged: 1 })]);
    expect(c.trend).toBe("none");
  });
});

describe("captureCoverage — failure breakdown & last failure", () => {
  it("breaks failures down by class (desc), names the most recent one", () => {
    const c = cov([
      entry(10, { outcome: "extraction-failed", reason: "extractor-timeout" }),
      entry(8, { outcome: "extraction-failed", reason: "extractor-timeout" }),
      entry(6, { outcome: "curate-failed", reason: "curate-runtime" }),
      entry(2, { outcome: "extraction-failed", reason: "extractor-unavailable" }),
      entry(1, { staged: 1 }), // a productive capture is not a failure
    ]);
    expect(c.failures).toEqual([
      { class: "extractor-timeout", count: 2 },
      { class: "curate-runtime", count: 1 },
      { class: "extractor-unavailable", count: 1 },
    ]);
    // Newest failure is the day-2 extractor-unavailable (the day-1 entry is a success).
    expect(c.lastFailure?.reason).toBe("extractor-unavailable");
    expect(c.lastFailure?.outcome).toBe("extraction-failed");
  });

  it("a synthetic burst of failures drops the 7-day ratio to zero and names the class (#235 Done)", () => {
    const c = cov([
      entry(1, { outcome: "extraction-failed", reason: "extractor-unavailable" }),
      entry(2, { outcome: "extraction-failed", reason: "extractor-unavailable" }),
      entry(3, { outcome: "extraction-failed", reason: "extractor-unavailable" }),
    ]);
    expect(c.short.ratio).toBe(0);
    expect(c.failures[0]).toEqual({ class: "extractor-unavailable", count: 3 });
  });
});

describe("captureCoverage — per-brain filtering", () => {
  const multi: CaptureLogEntry[] = [
    entry(1, { brain: "/brains/team", staged: 1 }),
    entry(1, { brain: "/brains/other", outcome: "extraction-failed", reason: "extractor-failed" }),
    entry(2, { brain: "/brains/other", staged: 1 }),
    entry(2, { brain: null, staged: 1 }), // no brain routed
  ];

  it("counts only the health-checked brain's entries", () => {
    const team = cov(multi, "/brains/team");
    expect(team.short.seen).toBe(1);
    expect(team.short.productive).toBe(1);
    expect(team.failures).toEqual([]);

    const other = cov(multi, "/brains/other");
    expect(other.short.seen).toBe(2);
    expect(other.short.productive).toBe(1);
    expect(other.lastFailure?.reason).toBe("extractor-failed");
  });

  it("matches brains by resolved path, tolerating a trailing slash / '.' segments", () => {
    const c = cov(multi, "/brains/team/");
    expect(c.short.seen).toBe(1);
  });

  it("with no brainDir, counts every entry across brains", () => {
    const c = captureCoverage(multi, { now: NOW });
    expect(c.short.seen).toBe(4);
  });
});
