import { describe, expect, it, vi } from "vitest";
// Import the plain-ESM hook lib directly (no build step; hooks run it via `node`).
import { parseCandidateArray, sessionEnd, sessionStart } from "../hooks/lib.mjs";

/**
 * Build a fresh set of spy-backed deps for a test. Overrides let each test tune one seam
 * (e.g. force out-of-scope) while asserting the others are or aren't called.
 */
function makeDeps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    resolveBrainDir: vi.fn(async () => "/brains/acme"),
    isInScope: vi.fn(async () => true),
    getContext: vi.fn(async () => "## Relevant from the team brain\n- **X** (memory) — hi"),
    extractCandidates: vi.fn(async () => [{ kind: "memory", title: "T", body: "B" }]),
    capture: vi.fn(async (_brain: string, _cwd: string, candidates: unknown[]) => ({
      captured: candidates.length,
      staged: candidates,
    })),
    ...overrides,
  };
}

describe("sessionStart", () => {
  it("returns the injected context when a brain exists and cwd is in scope", async () => {
    const deps = makeDeps();
    const out = await sessionStart({ cwd: "/work/acme/app" }, deps);
    expect(out).toContain("Relevant from the team brain");
    expect(deps.resolveBrainDir).toHaveBeenCalledWith("/work/acme/app");
    expect(deps.getContext).toHaveBeenCalledWith("/brains/acme", "/work/acme/app");
  });

  it('returns "" and never injects when there is no brain for the cwd', async () => {
    const deps = makeDeps({ resolveBrainDir: vi.fn(async () => null) });
    const out = await sessionStart({ cwd: "/loose/project" }, deps);
    expect(out).toBe("");
    expect(deps.isInScope).not.toHaveBeenCalled();
    expect(deps.getContext).not.toHaveBeenCalled();
  });

  it('returns "" and never injects when the cwd is out of scope (scope gate)', async () => {
    const deps = makeDeps({ isInScope: vi.fn(async () => false) });
    const out = await sessionStart({ cwd: "/personal/secret" }, deps);
    expect(out).toBe("");
    expect(deps.getContext).not.toHaveBeenCalled();
  });

  it('returns "" for a missing cwd without touching any dep', async () => {
    const deps = makeDeps();
    const out = await sessionStart({}, deps);
    expect(out).toBe("");
    expect(deps.resolveBrainDir).not.toHaveBeenCalled();
  });
});

describe("sessionEnd", () => {
  it("captures the extracted candidates when a brain exists and cwd is in scope", async () => {
    const deps = makeDeps();
    const result = await sessionEnd(
      { cwd: "/work/acme/app", transcript_path: "/tmp/t.jsonl" },
      deps,
    );
    expect(deps.extractCandidates).toHaveBeenCalledWith("/tmp/t.jsonl");
    expect(deps.capture).toHaveBeenCalledWith("/brains/acme", "/work/acme/app", [
      { kind: "memory", title: "T", body: "B" },
    ]);
    expect(result).toEqual({ captured: 1, staged: [{ kind: "memory", title: "T", body: "B" }] });
  });

  it("skips (no brain) and NEVER extracts or captures", async () => {
    const deps = makeDeps({ resolveBrainDir: vi.fn(async () => null) });
    const result = await sessionEnd({ cwd: "/x", transcript_path: "/tmp/t.jsonl" }, deps);
    expect(result).toEqual({ skipped: true });
    expect(deps.isInScope).not.toHaveBeenCalled();
    expect(deps.extractCandidates).not.toHaveBeenCalled();
    expect(deps.capture).not.toHaveBeenCalled();
  });

  it("skips (out of scope) and NEVER extracts or captures — the scope gate", async () => {
    const deps = makeDeps({ isInScope: vi.fn(async () => false) });
    const result = await sessionEnd(
      { cwd: "/personal/secret", transcript_path: "/tmp/t.jsonl" },
      deps,
    );
    expect(result).toEqual({ skipped: true });
    expect(deps.extractCandidates).not.toHaveBeenCalled();
    expect(deps.capture).not.toHaveBeenCalled();
  });

  it("reports captured:0 and does not call capture when no candidates are extracted", async () => {
    const deps = makeDeps({ extractCandidates: vi.fn(async () => []) });
    const result = await sessionEnd(
      { cwd: "/work/acme/app", transcript_path: "/tmp/t.jsonl" },
      deps,
    );
    expect(result).toEqual({ captured: 0 });
    expect(deps.capture).not.toHaveBeenCalled();
  });
});

describe("parseCandidateArray", () => {
  it("parses a bare JSON array", () => {
    const out = parseCandidateArray('[{"kind":"memory","title":"t","body":"b"}]');
    expect(out).toEqual([{ kind: "memory", title: "t", body: "b" }]);
  });

  it("extracts an array embedded in prose / a code fence", () => {
    const text = 'Here you go:\n```json\n[{"kind":"memory","title":"t","body":"b"}]\n```\n';
    expect(parseCandidateArray(text)).toEqual([{ kind: "memory", title: "t", body: "b" }]);
  });

  it("drops malformed candidates and returns [] on non-arrays / junk", () => {
    expect(parseCandidateArray('[{"kind":"memory"}]')).toEqual([]); // missing title/body
    expect(parseCandidateArray("not json")).toEqual([]);
    expect(parseCandidateArray('{"kind":"memory"}')).toEqual([]);
    expect(parseCandidateArray("")).toEqual([]);
  });
});
