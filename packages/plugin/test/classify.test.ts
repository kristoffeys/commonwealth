import { describe, expect, it, vi } from "vitest";
import { createClassifier, parseClassifierOutput } from "../hooks/classify.mjs";

/**
 * The LLM curation classifier (ADR-0030) runs in the hook layer over the shared ADR-0027 host
 * runtime. Tests drive a FAKE `run` — never a real model — asserting the batch discipline (ONE call
 * for N candidates), correct verdict annotation by index, and that EVERY failure mode surfaces as a
 * structured failure so the caller can fail open to DISTINCT.
 */

const withNeighbors = (title, neighbors = []) => ({
  kind: "memory",
  title,
  body: `${title} — a durable body well past the length floor.`,
  neighbors,
});

describe("parseClassifierOutput", () => {
  it("parses a bare Claude array and a Codex verdicts object, keyed by index", () => {
    const array = JSON.stringify([
      { index: 0, judge: "durable", consolidation: "distinct", targetId: "", reason: "new" },
      { index: 1, judge: "trivia", consolidation: "distinct", targetId: "", reason: "noise" },
    ]);
    const map = parseClassifierOutput(array);
    expect(map.get(0)).toMatchObject({ judge: "durable", consolidation: "distinct" });
    expect(map.get(1)).toMatchObject({ judge: "trivia" });

    const obj = JSON.stringify({
      verdicts: [
        { index: 0, judge: "durable", consolidation: "supersedes", targetId: "old-1", reason: "r" },
      ],
    });
    expect(parseClassifierOutput(obj).get(0)).toMatchObject({
      consolidation: "supersedes",
      targetId: "old-1",
    });
  });

  it("tolerates a code fence / preamble and coerces unknown enum values to safe defaults", () => {
    const fenced =
      "```json\n" + JSON.stringify([{ index: 0, judge: "x", consolidation: "y" }]) + "\n```";
    expect(parseClassifierOutput(fenced).get(0)).toMatchObject({
      judge: "durable",
      consolidation: "distinct",
    });
  });

  it("returns null for empty / non-JSON output (caller fails open)", () => {
    expect(parseClassifierOutput("")).toBeNull();
    expect(parseClassifierOutput("not json at all")).toBeNull();
  });
});

describe("createClassifier", () => {
  it("makes exactly ONE batched call for N candidates and annotates each by index", async () => {
    const run = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify([
        {
          index: 0,
          judge: "durable",
          consolidation: "duplicate",
          targetId: "old-1",
          reason: "same",
        },
        { index: 1, judge: "trivia", consolidation: "distinct", targetId: "", reason: "noise" },
      ]),
      stderr: "",
    }));
    const classifier = createClassifier({ host: "claude", run, claudeBin: "claude-test" });
    const res = await classifier.classify({
      candidates: [
        withNeighbors("A", [{ id: "old-1", kind: "memory", title: "Old", excerpt: "..." }]),
        withNeighbors("B"),
      ],
      cwd: "/work",
    });

    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0]).toBe("claude-test");
    expect(res.ok).toBe(true);
    expect(res.candidates).toHaveLength(2);
    expect(res.candidates[0].verdict).toMatchObject({
      consolidation: "duplicate",
      targetId: "old-1",
    });
    expect(res.candidates[1].verdict).toMatchObject({ judge: "trivia" });
    // Neighbors are stripped, but their IDS are transported as the clamp allow-list for capture.
    expect(res.candidates[0]).not.toHaveProperty("neighbors");
    expect(res.candidates[0].neighborIds).toEqual(["old-1"]);
    expect(res.candidates[1].neighborIds).toEqual([]);
  });

  it("transports neighbor ids (not the neighbor objects) across the classify → capture boundary", async () => {
    const run = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify([
        { index: 0, judge: "durable", consolidation: "distinct", targetId: "" },
      ]),
      stderr: "",
    }));
    const classifier = createClassifier({ host: "claude", run });
    const res = await classifier.classify({
      candidates: [
        withNeighbors("A", [
          { id: "n-1", kind: "memory", title: "One", excerpt: "..." },
          { id: "n-2", kind: "memory", title: "Two", excerpt: "..." },
        ]),
      ],
    });
    expect(res.candidates[0].neighborIds).toEqual(["n-1", "n-2"]);
    expect(res.candidates[0]).not.toHaveProperty("neighbors");
  });

  it("sends only DATA (kind/title/body/neighbors) on stdin — never note ids or provenance", async () => {
    let stdin = "";
    const run = vi.fn(async (_cmd, _args, opts) => {
      stdin = opts.input;
      return { code: 0, stdout: "[]", stderr: "" };
    });
    const classifier = createClassifier({ host: "claude", run });
    await classifier.classify({
      candidates: [
        {
          kind: "memory",
          title: "T",
          body: "b",
          source: "acme/repo",
          author: "Alice",
          neighbors: [],
        },
      ],
    });
    const payload = JSON.parse(stdin);
    expect(payload[0]).toEqual({ index: 0, kind: "memory", title: "T", body: "b", neighbors: [] });
    expect(stdin).not.toContain("acme/repo");
    expect(stdin).not.toContain("Alice");
  });

  it("leaves a candidate unannotated when the classifier omits its index", async () => {
    const run = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify([
        { index: 0, judge: "durable", consolidation: "distinct", targetId: "" },
      ]),
      stderr: "",
    }));
    const classifier = createClassifier({ host: "claude", run });
    const res = await classifier.classify({ candidates: [withNeighbors("A"), withNeighbors("B")] });
    expect(res.candidates[0].verdict).toBeTruthy();
    expect(res.candidates[1].verdict).toBeUndefined();
  });

  it("fails (not throws) on a missing runtime, a timeout, and garbage output", async () => {
    const missing = createClassifier({
      host: "claude",
      run: async () => ({
        code: null,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("x"), { code: "ENOENT" }),
      }),
    });
    await expect(missing.classify({ candidates: [withNeighbors("A")] })).resolves.toMatchObject({
      ok: false,
      reason: "extractor-unavailable",
    });

    const timeout = createClassifier({
      host: "claude",
      run: async () => ({ code: null, signal: "SIGKILL", timedOut: true, stdout: "", stderr: "" }),
    });
    await expect(timeout.classify({ candidates: [withNeighbors("A")] })).resolves.toMatchObject({
      ok: false,
      reason: "extractor-timeout",
    });

    const garbage = createClassifier({
      host: "claude",
      run: async () => ({ code: 0, stdout: "sorry, I cannot help with that", stderr: "" }),
    });
    await expect(garbage.classify({ candidates: [withNeighbors("A")] })).resolves.toMatchObject({
      ok: false,
      reason: "malformed-output",
    });
  });

  it("makes no call for an empty candidate set", async () => {
    const run = vi.fn();
    const classifier = createClassifier({ host: "claude", run });
    const res = await classifier.classify({ candidates: [] });
    expect(run).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: true, candidates: [] });
  });
});
