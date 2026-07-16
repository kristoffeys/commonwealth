import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CaptureLogEntry,
  captureFixHint,
  failureStreak,
  formatAge,
  formatCaptureLine,
  readCaptureLog,
} from "../src/capture-log.js";

const tmpRoots: string[] = [];
afterEach(async () => {
  for (const root of tmpRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("capture-log reader (#211)", () => {
  it("reads and parses JSONL newest-last, skipping corrupt lines", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cw-cli-caplog-"));
    tmpRoots.push(root);
    const logPath = path.join(root, "capture.log");
    await fs.writeFile(
      logPath,
      [
        JSON.stringify({ outcome: "ok", captured: 1 }),
        "{ not valid json",
        JSON.stringify({ outcome: "extraction-failed", reason: "extractor-timeout" }),
        "", // blank line
      ].join("\n"),
    );
    const entries = await readCaptureLog(logPath);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ outcome: "extraction-failed" });
  });

  it("returns [] for a missing log", async () => {
    expect(await readCaptureLog(path.join(os.tmpdir(), "cw-nope.log"))).toEqual([]);
  });
});

describe("formatCaptureLine (#211)", () => {
  const now = 1_000_000_000;
  it("renders a successful capture with counts", () => {
    const line = formatCaptureLine(
      { ts: now - 60_000, outcome: "ok", captured: 3, promoted: 2, staged: 1 },
      now,
    );
    expect(line).toContain("✓ 3 note(s)");
    expect(line).toContain("2 promoted");
    expect(line).toContain("1m ago");
  });

  it("renders a filtered-to-zero capture without calling it a failure", () => {
    const line = formatCaptureLine({ ts: now, outcome: "ok", captured: 0, rejected: 4 }, now);
    expect(line).toContain("captured nothing");
    expect(line).toContain("4 candidate(s) filtered");
    expect(line).not.toContain("✗");
  });

  it("renders extraction/curate failures and skips distinctly", () => {
    expect(
      formatCaptureLine(
        { ts: now, outcome: "extraction-failed", reason: "extractor-timeout" },
        now,
      ),
    ).toContain("✗ extraction failed (extractor-timeout)");
    expect(
      formatCaptureLine({ ts: now, outcome: "curate-failed", reason: "curate-runtime" }, now),
    ).toContain("✗ curate failed");
    expect(formatCaptureLine({ ts: now, outcome: "skipped", reason: "no-brain" }, now)).toContain(
      "skipped (no-brain)",
    );
  });
});

describe("failureStreak + captureFixHint (#211)", () => {
  const f = (reason: string, outcome = "extraction-failed"): CaptureLogEntry =>
    ({ outcome, reason }) as CaptureLogEntry;

  it("counts the trailing run of the same failure class", () => {
    const streak = failureStreak([
      f("extractor-failed"),
      f("extractor-timeout"),
      f("extractor-timeout"),
      f("extractor-timeout"),
    ]);
    expect(streak).toEqual({ outcome: "extraction-failed", reason: "extractor-timeout", count: 3 });
  });

  it("returns null when the newest entry is not a failure", () => {
    expect(
      failureStreak([f("extractor-timeout"), { outcome: "ok" } as CaptureLogEntry]),
    ).toBeNull();
  });

  it("provides a fix hint per known class and null otherwise", () => {
    expect(captureFixHint("extractor-unavailable")).toContain("claude /login");
    expect(captureFixHint("malformed-output")).toContain("commonwealth update");
    expect(captureFixHint("something-else")).toBeNull();
  });
});

describe("formatAge (#211)", () => {
  it("bins ages into coarse buckets", () => {
    const now = 10_000_000_000;
    expect(formatAge(now, now)).toBe("just now");
    expect(formatAge(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatAge(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatAge(now - 5 * 86_400_000, now)).toBe("5d ago");
    expect(formatAge(undefined, now)).toBe("unknown time");
  });
});
