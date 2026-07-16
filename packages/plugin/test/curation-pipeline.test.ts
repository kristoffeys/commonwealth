import { describe, expect, it, vi } from "vitest";
import { endReceiptMessage, parseVerdictSummary, sessionEnd } from "../hooks/lib.mjs";

/**
 * The LLM curation pass (ADR-0030) is wired between extraction and capture in `sessionEnd`, and its
 * verdict summary flows back into the capture receipt. These tests drive the control flow through
 * injected deps (no real curate, no real model), covering: the classifier annotates candidates
 * before capture; a missing dep / fail-open pass-through leaves capture unchanged; and the receipt
 * reports superseded / contradiction / trivia counts.
 */

function makeDeps(overrides = {}) {
  return {
    resolveBrain: vi.fn(async () => ({ kind: "brain", brain: "/brains/acme" })),
    getContext: vi.fn(async () => ""),
    getContextQuery: vi.fn(async () => ""),
    extractCandidates: vi.fn(async () => ({
      ok: true,
      candidates: [{ kind: "memory", title: "T", body: "B" }],
    })),
    classifyCandidates: vi.fn(async (_brain, _cwd, candidates) =>
      candidates.map((c) => ({ ...c, verdict: { judge: "durable", consolidation: "distinct" } })),
    ),
    capture: vi.fn(async (_brain, _cwd, candidates) => ({
      captured: candidates.length,
      notes: candidates.map((c) => ({ kind: "memory", title: c.title ?? "T", promoted: true })),
    })),
    refreshStatus: vi.fn(async () => {}),
    saveReceipt: vi.fn(async () => {}),
    takeReceipt: vi.fn(async () => null),
    ...overrides,
  };
}

describe("sessionEnd LLM curation step", () => {
  it("classifies extracted candidates and passes the ANNOTATED set to capture", async () => {
    const deps = makeDeps();
    await sessionEnd({ cwd: "/work/acme/app", transcript_path: "/tmp/t.jsonl" }, deps);
    expect(deps.classifyCandidates).toHaveBeenCalledWith("/brains/acme", "/work/acme/app", [
      { kind: "memory", title: "T", body: "B" },
    ]);
    // capture receives the verdict-annotated candidate, not the bare one.
    expect(deps.capture).toHaveBeenCalledWith("/brains/acme", "/work/acme/app", [
      {
        kind: "memory",
        title: "T",
        body: "B",
        verdict: { judge: "durable", consolidation: "distinct" },
      },
    ]);
  });

  it("fails open: a classifier that returns the candidates unchanged still captures them", async () => {
    const deps = makeDeps({
      classifyCandidates: vi.fn(async (_b, _c, candidates) => candidates), // flag-off / error path
    });
    await sessionEnd({ cwd: "/work/acme/app", transcript_path: "/tmp/t.jsonl" }, deps);
    expect(deps.capture).toHaveBeenCalledWith("/brains/acme", "/work/acme/app", [
      { kind: "memory", title: "T", body: "B" },
    ]);
  });

  it("skips classification entirely when no classifyCandidates dep is wired", async () => {
    const deps = makeDeps();
    delete deps.classifyCandidates;
    const result = await sessionEnd(
      { cwd: "/work/acme/app", transcript_path: "/tmp/t.jsonl" },
      deps,
    );
    expect(result.captured).toBe(1);
    expect(deps.capture).toHaveBeenCalledWith("/brains/acme", "/work/acme/app", [
      { kind: "memory", title: "T", body: "B" },
    ]);
  });

  it("never classifies when extraction produced zero candidates", async () => {
    const deps = makeDeps({
      extractCandidates: vi.fn(async () => ({ ok: true, candidates: [] })),
    });
    await sessionEnd({ cwd: "/work/acme/app", transcript_path: "/tmp/t.jsonl" }, deps);
    expect(deps.classifyCandidates).not.toHaveBeenCalled();
    expect(deps.capture).not.toHaveBeenCalled();
  });
});

describe("parseVerdictSummary", () => {
  it("extracts the counts from the sentinel line and ignores everything else", () => {
    const stdout = [
      "promoted  memory/a.md  [memory]  New fact",
      '##commonwealth:verdicts {"superseded":1,"contradicted":1,"trivia":2,"duplicate":0}',
    ].join("\n");
    expect(parseVerdictSummary(stdout)).toEqual({
      superseded: 1,
      contradicted: 1,
      trivia: 2,
      duplicate: 0,
    });
  });

  it("returns null when no summary line is present", () => {
    expect(parseVerdictSummary("id  [memory]  Just a note")).toBeNull();
  });
});

describe("endReceiptMessage with curation verdicts", () => {
  it("names what the pass did on a real capture", () => {
    const msg = endReceiptMessage({
      captured: 3,
      notes: [
        { kind: "memory", title: "New auth model", promoted: true },
        { kind: "memory", title: "Cache TTL", promoted: true },
      ],
      verdicts: { superseded: 1, contradicted: 1, trivia: 2, duplicate: 0 },
    });
    expect(msg).toContain("superseded an older note");
    expect(msg).toContain("flagged as a contradiction");
    expect(msg).toContain("filtered as trivia");
  });

  it("explains a zero-capture that the judge filtered as trivia", () => {
    const msg = endReceiptMessage({
      captured: 0,
      verdicts: { superseded: 0, contradicted: 0, trivia: 2, duplicate: 0 },
    });
    expect(msg).toContain("filtered as trivia");
    expect(msg).not.toContain("no durable knowledge");
  });
});
