import { describe, expect, it, vi } from "vitest";
// Import the plain-ESM hook lib directly (no build step; hooks run it via `node`).
import {
  attachReceipt,
  buildSessionStartOutput,
  compactTranscript,
  deriveReceipt,
  endReceiptMessage,
  parseCandidateArray,
  sessionEnd,
  sessionStart,
} from "../hooks/lib.mjs";

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
    saveReceipt: vi.fn(async () => {}),
    takeReceipt: vi.fn(async () => null),
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

  it("falls back to $CLAUDE_PROJECT_DIR when the hook cwd maps to no brain (#174)", async () => {
    const prev = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = "/work/acme/app";
    try {
      const deps = makeDeps({
        resolveBrainDir: vi.fn(async (cwd: string) =>
          cwd === "/work/acme/app" ? "/brains/acme" : null,
        ),
      });
      // Orca's rate-limit PTY hands the hook a synthetic cwd that isn't in the registry.
      const out = await sessionStart({ cwd: "/synthetic/rate-limit-pty-cwd" }, deps);
      expect(out).toContain("Relevant from the team brain");
      // Scope + context are evaluated against the recovered project dir, not the synthetic cwd.
      expect(deps.isInScope).toHaveBeenCalledWith("/work/acme/app");
      expect(deps.getContext).toHaveBeenCalledWith("/brains/acme", "/work/acme/app");
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = prev;
    }
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

  it("skips (no brain) and NEVER extracts or captures, but leaves a receipt (#96)", async () => {
    const deps = makeDeps({ resolveBrainDir: vi.fn(async () => null) });
    const result = await sessionEnd({ cwd: "/x", transcript_path: "/tmp/t.jsonl" }, deps);
    expect(result).toEqual({ skipped: true, reason: "no-brain" });
    expect(deps.isInScope).not.toHaveBeenCalled();
    expect(deps.extractCandidates).not.toHaveBeenCalled();
    expect(deps.capture).not.toHaveBeenCalled();
    // A receipt for THIS cwd is saved so the next SessionStart can explain the silence.
    expect(deps.saveReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/x", message: expect.stringContaining("no team brain") }),
    );
  });

  it("skips (out of scope) and NEVER extracts or captures — the scope gate — but leaves a receipt", async () => {
    const deps = makeDeps({ isInScope: vi.fn(async () => false) });
    const result = await sessionEnd(
      { cwd: "/personal/secret", transcript_path: "/tmp/t.jsonl" },
      deps,
    );
    expect(result).toEqual({ skipped: true, reason: "out-of-scope" });
    expect(deps.extractCandidates).not.toHaveBeenCalled();
    expect(deps.capture).not.toHaveBeenCalled();
    expect(deps.saveReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/personal/secret",
        message: expect.stringContaining("capture scope"),
      }),
    );
  });

  it("reports captured:0, does not call capture, and leaves a 'nothing worth capturing' receipt", async () => {
    const deps = makeDeps({ extractCandidates: vi.fn(async () => []) });
    const result = await sessionEnd(
      { cwd: "/work/acme/app", transcript_path: "/tmp/t.jsonl" },
      deps,
    );
    expect(result).toEqual({ captured: 0 });
    expect(deps.capture).not.toHaveBeenCalled();
    expect(deps.saveReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("no durable knowledge") }),
    );
  });

  it("leaves a count receipt after a real capture", async () => {
    const deps = makeDeps();
    await sessionEnd({ cwd: "/work/acme/app", transcript_path: "/tmp/t.jsonl" }, deps);
    expect(deps.saveReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/work/acme/app",
        message: expect.stringContaining("1 note"),
      }),
    );
  });

  it("does not save a receipt when there is no cwd", async () => {
    const deps = makeDeps();
    const result = await sessionEnd({}, deps);
    expect(result).toEqual({ skipped: true, reason: "no-cwd" });
    expect(deps.saveReceipt).not.toHaveBeenCalled();
  });

  it("falls back to $CLAUDE_PROJECT_DIR and captures when the hook cwd maps to no brain (#174)", async () => {
    const prev = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = "/work/acme/app";
    try {
      const deps = makeDeps({
        resolveBrainDir: vi.fn(async (cwd: string) =>
          cwd === "/work/acme/app" ? "/brains/acme" : null,
        ),
      });
      const result = await sessionEnd(
        { cwd: "/synthetic/rate-limit-pty-cwd", transcript_path: "/tmp/t.jsonl" },
        deps,
      );
      // Capture runs against the recovered project dir + its brain, not the synthetic cwd.
      expect(deps.capture).toHaveBeenCalledWith("/brains/acme", "/work/acme/app", [
        { kind: "memory", title: "T", body: "B" },
      ]);
      expect(result).toEqual({ captured: 1, staged: [{ kind: "memory", title: "T", body: "B" }] });
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = prev;
    }
  });

  it("skips a synthetic PTY cwd SILENTLY (no receipt) when no fallback maps to a brain (#180)", async () => {
    // Orca's rate-limit PTY runs with $CLAUDE_PROJECT_DIR unset, so #174's fallback can't recover
    // the real project. Rather than nag "map it in your registry" every rate-limit cycle (wrong
    // advice — the project IS mapped), sessionEnd skips silently and leaves no receipt.
    const prev = process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
    try {
      const deps = makeDeps({ resolveBrainDir: vi.fn(async () => null) });
      const result = await sessionEnd(
        {
          cwd: "/Users/x/Library/Application Support/orca/rate-limit-pty-cwd",
          transcript_path: "/tmp/t.jsonl",
        },
        deps,
      );
      expect(result).toEqual({ skipped: true, reason: "synthetic-cwd" });
      expect(deps.extractCandidates).not.toHaveBeenCalled();
      expect(deps.capture).not.toHaveBeenCalled();
      // No receipt: nothing to surface on the next SessionStart in the synthetic cwd.
      expect(deps.saveReceipt).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = prev;
    }
  });

  it("a synthetic PTY cwd still captures when a fallback DOES recover a brain (#180)", async () => {
    // The silent-skip only kicks in when nothing maps. If $CLAUDE_PROJECT_DIR recovers the real
    // project, a session that merely launched via the PTY captures normally.
    const prev = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = "/work/acme/app";
    try {
      const deps = makeDeps({
        resolveBrainDir: vi.fn(async (cwd: string) =>
          cwd === "/work/acme/app" ? "/brains/acme" : null,
        ),
      });
      const result = await sessionEnd(
        { cwd: "/synthetic/rate-limit-pty-cwd", transcript_path: "/tmp/t.jsonl" },
        deps,
      );
      expect(deps.capture).toHaveBeenCalledWith("/brains/acme", "/work/acme/app", [
        { kind: "memory", title: "T", body: "B" },
      ]);
      expect(result).toEqual({ captured: 1, staged: [{ kind: "memory", title: "T", body: "B" }] });
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = prev;
    }
  });
});

describe("endReceiptMessage (#96)", () => {
  it("explains a no-brain skip", () => {
    expect(endReceiptMessage({ skipped: true, reason: "no-brain" })).toContain("no team brain");
  });
  it("explains an out-of-scope skip", () => {
    expect(endReceiptMessage({ skipped: true, reason: "out-of-scope" })).toContain("capture scope");
  });
  it("returns null for a no-cwd skip (nothing useful to say)", () => {
    expect(endReceiptMessage({ skipped: true, reason: "no-cwd" })).toBe(null);
  });
  it("returns null for a synthetic-cwd skip — the PTY nag is suppressed (#180)", () => {
    expect(endReceiptMessage({ skipped: true, reason: "synthetic-cwd" })).toBe(null);
  });
  it("reports zero and non-zero capture counts", () => {
    expect(endReceiptMessage({ captured: 0 })).toContain("no durable knowledge");
    expect(endReceiptMessage({ captured: 3 })).toContain("3 note(s)");
  });
  it("returns null for junk input", () => {
    expect(endReceiptMessage(null)).toBe(null);
    expect(endReceiptMessage({})).toBe(null);
  });
});

describe("attachReceipt (#96)", () => {
  it("returns null when there is neither output nor a receipt", () => {
    expect(attachReceipt(null, null)).toBe(null);
    expect(attachReceipt(null, "   ")).toBe(null);
  });
  it("emits a systemMessage-only output when there is a receipt but no context", () => {
    expect(attachReceipt(null, "🧠 nothing captured")).toEqual({
      systemMessage: "🧠 nothing captured",
    });
  });
  it("returns the output unchanged when there is no receipt", () => {
    const out = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "x" } };
    expect(attachReceipt(out, null)).toBe(out);
  });
  it("appends the receipt to an existing systemMessage without touching additionalContext", () => {
    const out = {
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "CTX" },
      systemMessage: "📖 Loaded 2 note(s).",
    };
    const merged = attachReceipt(out, "🧠 captured 1");
    expect(merged.systemMessage).toBe("📖 Loaded 2 note(s).\n🧠 captured 1");
    expect(merged.hookSpecificOutput.additionalContext).toBe("CTX"); // receipt never pollutes context
  });
});

describe("deriveReceipt", () => {
  it("reports the note count parsed from the heading", () => {
    const context = "## Team brain — 3 relevant note(s)\n- **X** (memory) — hi";
    expect(deriveReceipt(context)).toBe("📖 Loaded 3 note(s) from your team brain.");
  });

  it("falls back to a generic message when there is no heading/count", () => {
    expect(deriveReceipt("some context without a heading")).toBe(
      "📖 Loaded relevant context from your team brain.",
    );
  });
});

describe("buildSessionStartOutput", () => {
  it("returns null for empty/whitespace context", () => {
    expect(buildSessionStartOutput("")).toBe(null);
    expect(buildSessionStartOutput("   \n  ")).toBe(null);
  });

  it("wraps the context and derives a receipt for real context", () => {
    const context = "## Team brain — 3 relevant note(s)\n- **X** (memory) — hi";
    const out = buildSessionStartOutput(context);
    expect(out?.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out?.hookSpecificOutput.additionalContext).toBe(context);
    expect(out?.systemMessage).toContain("3 note");
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
    expect(parseCandidateArray('[{"kind":"memory","title":"","body":"x"}]')).toEqual([]); // empty title
  });

  it("normalizes an out-of-enum kind to memory instead of dropping the note (#88)", () => {
    const out = parseCandidateArray(
      '[{"kind":"architecture","title":"no queue worker","body":"uses defer()+Http::retry()"}]',
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("memory");
    expect(out[0].title).toBe("no queue worker");
    // A valid kind is preserved untouched.
    const ok = parseCandidateArray('[{"kind":"decision","title":"t","body":"b"}]');
    expect(ok[0].kind).toBe("decision");
  });
});

describe("compactTranscript (#84)", () => {
  it("keeps the whole conversation (head + tail) and elides bulky tool payloads", () => {
    const bigBlob = "F".repeat(50_000); // a huge tool_result (file read / command output)
    const jsonl = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "early decision: use Postgres" },
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", name: "Read" }] },
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: bigBlob }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "late note: cache TTL is 5m" }],
        },
      }),
    ].join("\n");

    const out = compactTranscript(jsonl);

    // The whole session is preserved — the EARLY line is not dropped.
    expect(out).toContain("early decision: use Postgres");
    expect(out).toContain("late note: cache TTL is 5m");
    expect(out).toContain("[tool_use: Read]");
    // The 50KB tool blob is truncated, not carried whole.
    expect(out).not.toContain(bigBlob);
    expect(out.length).toBeLessThan(2000);
  });

  it("returns empty for content that never parses (caller falls back to raw)", () => {
    expect(compactTranscript("not json at all\n{also not")).toBe("");
  });
});
