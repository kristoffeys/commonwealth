import { describe, expect, it, vi } from "vitest";
import { createReclassifier, parseReclassifyOutput } from "../hooks/reclassify.mjs";

/**
 * The LLM reclassification judge (#265) — the host-model piece that decides which existing MEMORY
 * notes are really decisions. The deterministic engine lives in @cmnwlth/curate and is tested there;
 * here we pin the parser and the fail-CLOSED wiring (any failure ⇒ zero conversions).
 */

describe("parseReclassifyOutput", () => {
  it("parses a bare Claude array and a Codex verdicts object", () => {
    const rows = [
      { index: 0, isDecision: true, title: "Adopt X", body: "…", reason: "choice" },
      { index: 1, isDecision: false, title: "", body: "", reason: "fact" },
    ];
    for (const stdout of [JSON.stringify(rows), JSON.stringify({ verdicts: rows })]) {
      const map = parseReclassifyOutput(stdout);
      expect(map?.get(0)).toMatchObject({ isDecision: true, title: "Adopt X" });
      expect(map?.get(1)).toMatchObject({ isDecision: false });
    }
  });

  it("tolerates a code fence / preamble around the JSON", () => {
    const map = parseReclassifyOutput(
      'Here you go:\n```json\n[{"index":0,"isDecision":true,"title":"T","body":"b","reason":"r"}]\n```',
    );
    expect(map?.get(0)).toMatchObject({ isDecision: true, title: "T" });
  });

  it("returns null for empty / non-JSON output (caller fails closed)", () => {
    expect(parseReclassifyOutput("")).toBeNull();
    expect(parseReclassifyOutput("   ")).toBeNull();
    expect(parseReclassifyOutput("not json")).toBeNull();
  });

  it("is fail-CLOSED per row: only a strict boolean true counts as a decision", () => {
    const map = parseReclassifyOutput(
      JSON.stringify([
        { index: 0, isDecision: "true", title: "x", body: "y", reason: "z" },
        { index: 1, isDecision: 1, title: "x", body: "y", reason: "z" },
        { index: 2, title: "x", body: "y", reason: "z" },
        { index: 3, isDecision: true, title: "x", body: "y", reason: "z" },
      ]),
    );
    expect(map?.get(0)?.isDecision).toBe(false);
    expect(map?.get(1)?.isDecision).toBe(false);
    expect(map?.get(2)?.isDecision).toBe(false);
    expect(map?.get(3)?.isDecision).toBe(true);
  });
});

describe("createReclassifier.judge", () => {
  it("makes ONE batched call and returns a Map<id> of ONLY the decisions, keyed by note id", async () => {
    const run = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify({
        verdicts: [
          { index: 0, isDecision: true, title: "Adopt Pinia", body: "…", reason: "adoption" },
          { index: 1, isDecision: false, title: "", body: "", reason: "gotcha" },
        ],
      }),
      stderr: "",
    }));
    const { judge } = createReclassifier({ host: "codex", run, codexBin: "codex-test" });
    const map = await judge([
      { id: "note-a", title: "adopt pinia colada", body: "…" },
      { id: "note-b", title: "jwt gotcha", body: "…" },
    ]);

    expect(run).toHaveBeenCalledOnce();
    expect(map.size).toBe(1);
    expect(map.get("note-a")).toMatchObject({ isDecision: true, title: "Adopt Pinia" });
    expect(map.has("note-b")).toBe(false); // non-decision omitted
  });

  it("sends only DATA (index/title/body) on stdin — never note ids", async () => {
    let stdin = "";
    const run = vi.fn(async (_cmd, _args, opts) => {
      stdin = opts.input;
      return { code: 0, stdout: '{"verdicts":[]}', stderr: "" };
    });
    const { judge } = createReclassifier({ host: "codex", run });
    await judge([{ id: "secret-id-123", title: "T", body: "b" }]);
    const payload = JSON.parse(stdin);
    expect(payload[0]).toEqual({ index: 0, title: "T", body: "b" });
    expect(stdin).not.toContain("secret-id-123");
  });

  it("fails CLOSED (empty map) on a non-zero exit and on malformed output", async () => {
    const fail = createReclassifier({ host: "codex", run: async () => ({ code: 1, stdout: "", stderr: "boom" }) });
    expect((await fail.judge([{ id: "a", title: "t", body: "b" }])).size).toBe(0);

    const garbage = createReclassifier({ host: "codex", run: async () => ({ code: 0, stdout: "not json", stderr: "" }) });
    expect((await garbage.judge([{ id: "a", title: "t", body: "b" }])).size).toBe(0);
  });

  it("makes no call for an empty note set", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "[]", stderr: "" }));
    const { judge } = createReclassifier({ host: "codex", run });
    expect((await judge([])).size).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });
});
