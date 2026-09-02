import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REDACTED_TITLE, readReceipts, setFeature, summarizeDrops } from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureCandidates } from "../src/capture.js";
import { curate } from "../src/curate.js";

/**
 * Capture receipts through the real gates (ADR-0039, #266). The unit table lives in
 * `@cmnwlth/core`; these prove the wiring: every gate that drops a candidate attaches a structured
 * classification, and `captureCandidates` PERSISTS one receipt per drop into the brain's derived
 * `index/` — the thing that was missing when a detached SessionEnd worker vetoed a decision and
 * exited with the reason in nobody's hands.
 */

let brainDir: string;

beforeEach(async () => {
  brainDir = await fs.mkdtemp(path.join(tmpdir(), "commonwealth-curate-receipts-"));
});

afterEach(async () => {
  await fs.rm(brainDir, { recursive: true, force: true });
});

const decision = {
  kind: "decision" as const,
  title: "Adopt trunk-based development",
  body: "We will commit to short-lived branches merged to main daily to reduce integration pain.",
};

const memory = {
  kind: "memory" as const,
  title: "CI runs on GitHub Actions",
  body: "The continuous integration pipeline is defined in .github/workflows and runs on push.",
};

describe("curate attaches a structured drop to every rejection", () => {
  it("classifies the autoAdr veto — the #266 case — as recoverable, with the flag fix", async () => {
    await setFeature(brainDir, "autoAdr", false);

    const result = await curate(brainDir, [decision, memory]);

    expect(result.rejected).toHaveLength(1);
    const drop = result.rejected[0]!.drop;
    expect(drop.category).toBe("autoadr-vetoed");
    expect(drop.recoverable).toBe(true);
    expect(drop.nextAction).toContain("autoAdr");
    // The legacy free-text reason is untouched — existing readers keep working.
    expect(result.rejected[0]!.reason).toBe("auto-adr-disabled");
  });

  it("classifies a secret-bearing candidate, and the receipt withholds its title", async () => {
    const result = await curate(brainDir, [
      {
        kind: "memory",
        title: "Staging AWS key",
        body: "The staging key is AKIAIOSFODNN7EXAMPLE and it is used by the nightly job.",
      },
    ]);

    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.drop.category).toBe("secret-detected");
    expect(result.rejected[0]!.drop.recoverable).toBe(true);
  });

  it("classifies a too-thin candidate and a lexical duplicate distinctly", async () => {
    const thin = await curate(brainDir, [{ kind: "memory", title: "x", body: "short" }]);
    expect(thin.rejected[0]!.drop.category).toBe("too-thin");

    await curate(brainDir, [memory]);
    const dupe = await curate(brainDir, [memory]);
    expect(dupe.rejected).toHaveLength(1);
    expect(dupe.rejected[0]!.drop.category).toBe("duplicate-lexical");
    expect(dupe.rejected[0]!.drop.recoverable).toBe(false);
    expect(dupe.rejected[0]!.drop.cause).toContain(dupe.rejected[0]!.duplicateOf!);
  });
});

describe("captureCandidates persists receipts", () => {
  it("writes one receipt per drop into the brain's derived index/ dir", async () => {
    await setFeature(brainDir, "autoAdr", false);

    const result = await captureCandidates(brainDir, [decision, memory]);
    expect(result.staged).toHaveLength(1);

    const receipts = await readReceipts(brainDir);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      category: "autoadr-vetoed",
      recoverable: true,
      kind: "decision",
      title: decision.title,
      brain: path.resolve(brainDir),
    });
    expect(typeof receipts[0]?.ts).toBe("number");
  });

  it("aggregates across gates and sessions — counts per class, not N loose strings", async () => {
    await setFeature(brainDir, "autoAdr", false);
    await captureCandidates(brainDir, [decision, memory]);
    // Second session: the decision is vetoed again, and the memory is now a duplicate of canon.
    await captureCandidates(brainDir, [decision, memory]);

    const summary = summarizeDrops(await readReceipts(brainDir));
    expect(summary.total).toBe(3);
    expect(Object.fromEntries(summary.byCategory.map((e) => [e.category, e.count]))).toEqual({
      "autoadr-vetoed": 2,
      "duplicate-lexical": 1,
    });
    expect(summary.recoverable).toBe(2);
  });

  it("records the LLM classifier's pre-gate drops too (trivia / duplicate; ADR-0030)", async () => {
    const staged = await captureCandidates(brainDir, [memory]);
    const canonId = staged.staged[0]!.frontmatter.id;

    await captureCandidates(brainDir, [
      { ...decision, verdict: { judge: "trivia", consolidation: "distinct" } },
      {
        kind: "memory",
        title: "The CI pipeline lives in GitHub Actions",
        body: "Continuous integration is configured under .github/workflows for every push.",
        verdict: { judge: "durable", consolidation: "duplicate", targetId: canonId },
        neighborIds: [canonId],
      },
    ]);

    const summary = summarizeDrops(await readReceipts(brainDir));
    expect(Object.fromEntries(summary.byCategory.map((e) => [e.category, e.count]))).toEqual({
      trivia: 1,
      "duplicate-llm": 1,
    });
    // Neither is the user's fault, so neither nags.
    expect(summary.recoverable).toBe(0);
  });

  it("never writes a credential-bearing title, even on the pre-gate classifier path", async () => {
    // A `trivia` verdict is applied BEFORE curate()'s secret gate runs, so this candidate is never
    // scanned by the gate. The receipt must still not carry the credential to disk.
    await captureCandidates(brainDir, [
      {
        kind: "memory",
        title: "rotate AKIAIOSFODNN7EXAMPLE before Friday",
        body: "The staging deploy job still uses the old key and needs it rotated this week.",
        verdict: { judge: "trivia", consolidation: "distinct" },
      },
    ]);

    const receipts = await readReceipts(brainDir);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.category).toBe("trivia");
    expect(receipts[0]?.title).toBe(REDACTED_TITLE);
    const raw = await fs.readFile(path.join(brainDir, "index", "receipts.jsonl"), "utf8");
    expect(raw).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("honours the brain's entropy setting when redacting a pre-gate drop", async () => {
    await fs.mkdir(path.join(brainDir, ".commonwealth"), { recursive: true });
    await fs.writeFile(
      path.join(brainDir, ".commonwealth", "config.json"),
      JSON.stringify({ name: "test", secretScan: { entropy: true } }),
    );
    const token = "f1bjAFsAhASOZ7mGccwx3kNoA4vbAzRslEEXiLzm";

    await captureCandidates(brainDir, [
      {
        kind: "memory",
        title: `api token ${token}`,
        body: "The nightly job authenticates with this token and it should move to the vault.",
        verdict: { judge: "trivia", consolidation: "distinct" },
      },
    ]);

    const raw = await fs.readFile(path.join(brainDir, "index", "receipts.jsonl"), "utf8");
    expect(raw).not.toContain(token);
    expect((await readReceipts(brainDir))[0]?.title).toBe(REDACTED_TITLE);
  });

  it("a capture that drops nothing writes no receipt file at all", async () => {
    await captureCandidates(brainDir, [memory]);
    expect(await readReceipts(brainDir)).toEqual([]);
  });

  it("a failed receipt write never costs a note (capture succeeds regardless)", async () => {
    // Receipts are a derived diagnostic; canon is the product. Make the log unwritable and prove
    // the candidate still lands.
    await fs.mkdir(path.join(brainDir, "index", "receipts.jsonl"), { recursive: true });

    const result = await captureCandidates(brainDir, [memory]);
    expect(result.staged).toHaveLength(1);
    expect(result.promoted).toHaveLength(1);
    expect(await readReceipts(brainDir)).toEqual([]);
  });
});
