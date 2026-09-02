import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendReceipts,
  classifyDrop,
  dropFor,
  formatDropSummary,
  readReceipts,
  receiptFor,
  receiptsPath,
  RECEIPT_HIGH_WATER,
  RECEIPT_REPORT_WINDOW_DAYS,
  RECEIPT_WINDOW,
  REDACTED_TITLE,
  summarizeDrops,
  type CaptureReceipt,
} from "../src/receipts.js";

/**
 * Capture receipts (ADR-0037, #266): the structured, persisted answer to "a candidate was dropped —
 * why, and what do I do about it?". These cover the classification table, the redaction rule, the
 * derived/disposable storage (including the CONCURRENT writer path, which is the one that must not
 * lose or tear receipts), the rolling bound, and the aggregate.
 */

let brainDir: string;

beforeEach(async () => {
  brainDir = await fs.mkdtemp(path.join(tmpdir(), "commonwealth-receipts-"));
});

afterEach(async () => {
  await fs.rm(brainDir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-09-02T10:00:00Z");

describe("drop classification", () => {
  it("marks user-fixable drops recoverable and gives each a concrete next action", () => {
    for (const category of ["secret-detected", "autoadr-vetoed", "too-thin"] as const) {
      const drop = dropFor(category);
      expect(drop.category).toBe(category);
      expect(drop.recoverable).toBe(true);
      expect(drop.cause.length).toBeGreaterThan(0);
      expect(drop.nextAction).toBeTruthy();
    }
  });

  it("the autoAdr veto (#266) names the flag and how to change it", () => {
    const drop = dropFor("autoadr-vetoed");
    expect(drop.cause).toContain("autoAdr");
    expect(drop.nextAction).toContain("autoAdr");
    expect(drop.nextAction).toContain("config.json");
  });

  it("correct-by-design drops (duplicate/trivia) are NOT recoverable, and name the target", () => {
    const dup = dropFor("duplicate-semantic", { duplicateOf: "note-abc" });
    expect(dup.recoverable).toBe(false);
    expect(dup.cause).toContain("note-abc");
    expect(dup.nextAction).toBeNull();
    expect(dropFor("trivia").recoverable).toBe(false);
  });

  it("distinguishes the three duplicate gates, which a single `reason` string could not", () => {
    const categories = ["duplicate-lexical", "duplicate-semantic", "duplicate-llm"] as const;
    const causes = categories.map((c) => dropFor(c, { duplicateOf: "n1" }).cause);
    expect(new Set(causes).size).toBe(3);
  });

  it("classifies every reason string the gates emit today", () => {
    expect(classifyDrop("contains-secret").category).toBe("secret-detected");
    expect(classifyDrop("auto-adr-disabled").category).toBe("autoadr-vetoed");
    expect(classifyDrop("too-thin").category).toBe("too-thin");
    expect(classifyDrop("duplicate", "n1").category).toBe("duplicate-lexical");
    expect(classifyDrop("llm-duplicate", "n1").category).toBe("duplicate-llm");
    expect(classifyDrop("llm-trivia").category).toBe("trivia");
    expect(classifyDrop("invalid: kind must be one of …").category).toBe("invalid");
  });

  it("an unrecognized curator reason is `unknown` — still counted, never swallowed", () => {
    // The ADR-0007 curator seam is pluggable, so a custom curator can return anything. It must
    // still produce a loud receipt rather than falling out of the tally.
    const drop = classifyDrop("my-custom-gate-said-no");
    expect(drop.category).toBe("unknown");
    expect(drop.cause).toContain("my-custom-gate-said-no");
  });
});

describe("receiptFor", () => {
  it("records the candidate title, kind, raw reason and duplicate target", () => {
    const r = receiptFor(
      brainDir,
      {
        title: "Use Postgres for the ledger",
        kind: "decision",
        reason: "duplicate",
        duplicateOf: "n1",
        drop: dropFor("duplicate-lexical", { duplicateOf: "n1" }),
      },
      NOW,
    );
    expect(r).toMatchObject({
      ts: NOW,
      brain: path.resolve(brainDir),
      title: "Use Postgres for the ledger",
      kind: "decision",
      reason: "duplicate",
      duplicateOf: "n1",
      category: "duplicate-lexical",
      recoverable: false,
    });
  });

  it("REDACTS a credential-bearing title on ANY drop path, not just the secret gate's", () => {
    // The ADR-0030 classifier rejects trivia/duplicates in captureCandidates BEFORE curate() scans
    // anything, so those candidates never touch the secret gate. Keying redaction on the category
    // alone would write their titles to disk in the clear.
    const r = receiptFor(
      brainDir,
      {
        title: "rotate AKIAIOSFODNN7EXAMPLE next sprint",
        kind: "memory",
        reason: "llm-trivia",
        drop: dropFor("trivia"),
      },
      NOW,
    );
    expect(r.category).toBe("trivia");
    expect(r.title).toBe(REDACTED_TITLE);
    expect(JSON.stringify(r)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("uses the BRAIN's scanner settings — an entropy-only token is redacted when the brain opted in", () => {
    // A brain with entropy detection on (#46) has a strictly stronger gate than the defaults.
    // Redacting with the default scan would leak exactly the prefix-less tokens entropy catches.
    const token = "f1bjAFsAhASOZ7mGccwx3kNoA4vbAzRslEEXiLzm";
    const dropped = {
      title: `api token ${token}`,
      kind: "memory",
      reason: "llm-trivia",
      drop: dropFor("trivia"),
    };
    expect(receiptFor(brainDir, dropped, NOW).title).toContain(token);
    expect(receiptFor(brainDir, dropped, NOW, { detectEntropy: true }).title).toBe(REDACTED_TITLE);
  });

  it("REDACTS the title of a secret-detected drop — a receipt must not persist the credential", () => {
    const r = receiptFor(
      brainDir,
      {
        title: "AWS key AKIAIOSFODNN7EXAMPLE for staging",
        kind: "memory",
        reason: "contains-secret",
        drop: dropFor("secret-detected"),
      },
      NOW,
    );
    expect(r.title).toBe(REDACTED_TITLE);
    expect(JSON.stringify(r)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});

/** A receipt with sane defaults; `over` narrows it for a specific case. */
function receipt(over: Partial<CaptureReceipt> = {}): CaptureReceipt {
  return {
    ...dropFor("trivia"),
    ts: NOW,
    brain: "/brains/team",
    title: "A candidate",
    kind: "memory",
    reason: "llm-trivia",
    ...over,
  };
}

describe("persistence", () => {
  it("round-trips receipts through the brain's gitignored index/ dir", async () => {
    expect(receiptsPath(brainDir)).toBe(path.join(brainDir, "index", "receipts.jsonl"));
    expect(await readReceipts(brainDir)).toEqual([]);

    await appendReceipts(brainDir, [receipt({ title: "one" }), receipt({ title: "two" })]);
    const read = await readReceipts(brainDir);
    expect(read.map((r) => r.title)).toEqual(["one", "two"]);
    expect(read[0]?.category).toBe("trivia");
  });

  it("appends across runs rather than replacing (the log is a rolling tail, oldest first)", async () => {
    await appendReceipts(brainDir, [receipt({ title: "first" })]);
    await appendReceipts(brainDir, [receipt({ title: "second" })]);
    expect((await readReceipts(brainDir)).map((r) => r.title)).toEqual(["first", "second"]);
  });

  it("survives a torn/corrupt line without losing the receipts after it", async () => {
    await appendReceipts(brainDir, [receipt({ title: "before" })]);
    await fs.appendFile(receiptsPath(brainDir), '{"category":"tri\n', "utf8");
    await appendReceipts(brainDir, [receipt({ title: "after" })]);
    expect((await readReceipts(brainDir)).map((r) => r.title)).toEqual(["before", "after"]);
  });

  it("CONCURRENT writers never tear or lose a batch (one O_APPEND write per batch)", async () => {
    // Every session's capture worker appends to the same file. This is the concurrency-sensitive
    // path CLAUDE.md requires a test for: interleaving must be at whole-batch granularity, so no
    // reader ever sees a half-written line and no worker clobbers another's receipts.
    const writers = Array.from({ length: 12 }, (_, i) =>
      appendReceipts(brainDir, [receipt({ title: `w${i}-a` }), receipt({ title: `w${i}-b` })]),
    );
    await Promise.all(writers);

    const read = await readReceipts(brainDir);
    expect(read).toHaveLength(24);
    expect(new Set(read.map((r) => r.title)).size).toBe(24);
    // No line was mangled into an unparseable one (readReceipts silently skips those).
    const lines = (await fs.readFile(receiptsPath(brainDir), "utf8"))
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(24);
  });

  it("bounds growth to the rolling window, keeping the NEWEST receipts", async () => {
    for (let i = 0; i < 45; i += 1) {
      await appendReceipts(
        brainDir,
        Array.from({ length: 10 }, (_, j) => receipt({ title: `r${i * 10 + j}` })),
      );
    }
    const read = await readReceipts(brainDir);
    // Bounded by the high-water mark between writes (a trim cuts back to RECEIPT_WINDOW), and it is
    // always the OLDEST receipts that go — a drop from ten minutes ago outranks one from March.
    expect(read.length).toBeLessThanOrEqual(RECEIPT_HIGH_WATER);
    expect(read.length).toBeGreaterThanOrEqual(RECEIPT_WINDOW);
    expect(read[read.length - 1]?.title).toBe("r449");
    expect(read.some((r) => r.title === "r0")).toBe(false);
  });

  it("is best-effort: an unwritable location is swallowed, never fails a capture", async () => {
    // A receipt is a diagnostic. Losing one is a worse day; failing the capture would lose a note.
    const file = receiptsPath(brainDir);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.mkdir(file); // a directory where the log should be → every write errors
    await expect(appendReceipts(brainDir, [receipt()])).resolves.toBeUndefined();
    expect(await readReceipts(brainDir)).toEqual([]);
  });
});

describe("summarizeDrops", () => {
  it("aggregates by class — the point of receipts — most frequent first", () => {
    const summary = summarizeDrops([
      receipt({ ...dropFor("duplicate-lexical", { duplicateOf: "n1" }), ts: NOW - 1000 }),
      receipt({ ...dropFor("duplicate-lexical", { duplicateOf: "n2" }) }),
      receipt({ ...dropFor("duplicate-lexical", { duplicateOf: "n3" }) }),
      receipt({ ...dropFor("secret-detected") }),
      receipt({ ...dropFor("autoadr-vetoed") }),
      receipt({ ...dropFor("autoadr-vetoed"), ts: NOW + 5000 }),
    ]);
    expect(summary.total).toBe(6);
    expect(summary.recoverable).toBe(3);
    expect(summary.newestTs).toBe(NOW + 5000);
    expect(summary.byCategory.map((e) => [e.category, e.count])).toEqual([
      ["duplicate-lexical", 3],
      ["autoadr-vetoed", 2],
      ["secret-detected", 1],
    ]);
    expect(formatDropSummary(summary)).toBe(
      "3 duplicate (lexical), 2 autoAdr-vetoed, 1 secret-blocked",
    );
  });

  it("honours a `since` window so a fixed problem stops being reported", () => {
    const DAY = 86_400_000;
    const all = [
      receipt({ ...dropFor("autoadr-vetoed"), ts: NOW - 90 * DAY }),
      receipt({ ...dropFor("autoadr-vetoed"), ts: NOW - 2 * DAY }),
      receipt({ ...dropFor("trivia"), ts: NOW - 30 * DAY }),
    ];
    expect(summarizeDrops(all).total).toBe(3);

    const recent = summarizeDrops(all, { since: NOW - RECEIPT_REPORT_WINDOW_DAYS * DAY });
    expect(recent.total).toBe(1);
    expect(recent.byCategory).toEqual([
      { category: "autoadr-vetoed", count: 1, recoverable: true, nextAction: expect.any(String) },
    ]);
  });

  it("takes the advice from the CURRENT table, not from what an old receipt persisted", () => {
    // A receipt written by an older version carries that version's wording; what we print must be
    // the advice this version actually stands behind.
    const stale = receipt({
      ...dropFor("autoadr-vetoed"),
      recoverable: false,
      nextAction: "advice from a previous release",
    });
    const entry = summarizeDrops([stale]).byCategory[0]!;
    expect(entry.recoverable).toBe(true);
    expect(entry.nextAction).toBe(dropFor("autoadr-vetoed").nextAction);
    expect(summarizeDrops([stale]).recoverable).toBe(1);
  });

  it("reports autoAdr vetoes as history — not as something to fix — once the flag is back on", () => {
    // Otherwise every surface keeps offering a fix the user already applied, which is the
    // stale-warning bug in a different costume. One rule, so doctor and status cannot disagree.
    const receipts = [receipt({ ...dropFor("autoadr-vetoed") }), receipt({ ...dropFor("trivia") })];

    const off = summarizeDrops(receipts, { autoAdrEnabled: false });
    expect(off.recoverable).toBe(1);
    expect(off.byCategory.find((e) => e.category === "autoadr-vetoed")?.nextAction).toBeTruthy();

    const on = summarizeDrops(receipts, { autoAdrEnabled: true });
    expect(on.total).toBe(2);
    expect(on.recoverable).toBe(0);
    const entry = on.byCategory.find((e) => e.category === "autoadr-vetoed")!;
    expect(entry.count).toBe(1);
    expect(entry.recoverable).toBe(false);
    expect(entry.nextAction).toBeNull();
  });

  it("is empty-safe", () => {
    const summary = summarizeDrops([]);
    expect(summary).toEqual({ total: 0, recoverable: 0, byCategory: [], newestTs: null });
    expect(formatDropSummary(summary)).toBe("");
  });
});
