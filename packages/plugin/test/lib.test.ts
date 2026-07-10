import { describe, expect, it, vi } from "vitest";
// Import the plain-ESM hook lib directly (no build step; hooks run it via `node`).
import {
  attachReceipt,
  buildSessionStartOutput,
  buildUserPromptSubmitOutput,
  compactTranscript,
  deriveReceipt,
  endReceiptMessage,
  launchCaptureWorker,
  parseCandidateArray,
  parseCaptureLines,
  promptCaptureIntervalMs,
  sessionEnd,
  sessionStart,
  shouldCaptureNow,
  userPromptSubmit,
} from "../hooks/lib.mjs";

/**
 * Build a fresh set of spy-backed deps for a test. Overrides let each test tune one seam
 * (e.g. force out-of-scope) while asserting the others are or aren't called.
 */
function makeDeps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    // ADR-0024 §3: one pass is both routing and scope — `brain` in scope, `denied` out of scope.
    resolveBrain: vi.fn(async () => ({ kind: "brain", brain: "/brains/acme" })),
    getContext: vi.fn(async () => "## Relevant from the team brain\n- **X** (memory) — hi"),
    getContextQuery: vi.fn(
      async () => "## Team brain — 2 relevant note(s)\n- **JWT** (memory) — 15m expiry",
    ),
    extractCandidates: vi.fn(async () => [{ kind: "memory", title: "T", body: "B" }]),
    capture: vi.fn(async (_brain: string, _cwd: string, candidates: { title?: string }[]) => ({
      captured: candidates.length,
      // Mirror the real dep's shape (#204): structured notes carrying kind + title + promoted
      // (autoPromote on by default → promoted straight to canon).
      notes: candidates.map((c) => ({ kind: "memory", title: c.title ?? "T", promoted: true })),
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
    expect(deps.resolveBrain).toHaveBeenCalledWith("/work/acme/app");
    expect(deps.getContext).toHaveBeenCalledWith("/brains/acme", "/work/acme/app");
  });

  it('returns "" and never injects when nothing is configured for the cwd (none)', async () => {
    const deps = makeDeps({ resolveBrain: vi.fn(async () => ({ kind: "none" })) });
    const out = await sessionStart({ cwd: "/loose/project" }, deps);
    expect(out).toBe("");
    expect(deps.getContext).not.toHaveBeenCalled();
  });

  it('returns "" and never injects when the cwd is out of scope (denied — the scope gate)', async () => {
    const deps = makeDeps({ resolveBrain: vi.fn(async () => ({ kind: "denied" })) });
    const out = await sessionStart({ cwd: "/personal/secret" }, deps);
    expect(out).toBe("");
    expect(deps.getContext).not.toHaveBeenCalled();
  });

  it('returns "" for a missing cwd without touching any dep', async () => {
    const deps = makeDeps();
    const out = await sessionStart({}, deps);
    expect(out).toBe("");
    expect(deps.resolveBrain).not.toHaveBeenCalled();
  });

  it("falls back to $CLAUDE_PROJECT_DIR when the hook cwd maps to no brain (#174)", async () => {
    const prev = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = "/work/acme/app";
    try {
      const deps = makeDeps({
        resolveBrain: vi.fn(async (cwd: string) =>
          cwd === "/work/acme/app" ? { kind: "brain", brain: "/brains/acme" } : { kind: "none" },
        ),
      });
      // Orca's rate-limit PTY hands the hook a synthetic cwd that isn't in the registry.
      const out = await sessionStart({ cwd: "/synthetic/rate-limit-pty-cwd" }, deps);
      expect(out).toContain("Relevant from the team brain");
      // Resolution + context are evaluated against the recovered project dir, not the synthetic cwd.
      expect(deps.resolveBrain).toHaveBeenCalledWith("/work/acme/app");
      expect(deps.getContext).toHaveBeenCalledWith("/brains/acme", "/work/acme/app");
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = prev;
    }
  });
});

describe("userPromptSubmit (#194)", () => {
  it("injects prompt-scoped context via the query path when in scope + matched", async () => {
    const deps = makeDeps();
    const out = await userPromptSubmit(
      { cwd: "/work/acme/app", prompt: "how long is the JWT?" },
      deps,
    );
    expect(out).toContain("JWT");
    expect(deps.resolveBrain).toHaveBeenCalledWith("/work/acme/app");
    // The QUERY path is used (not the no-query session-wide getContext).
    expect(deps.getContextQuery).toHaveBeenCalledWith(
      "/brains/acme",
      "/work/acme/app",
      "how long is the JWT?",
    );
    expect(deps.getContext).not.toHaveBeenCalled();
  });

  it("tolerates the `user_prompt` field name too", async () => {
    const deps = makeDeps();
    await userPromptSubmit({ cwd: "/work/acme/app", user_prompt: "cache ttl?" }, deps);
    expect(deps.getContextQuery).toHaveBeenCalledWith(
      "/brains/acme",
      "/work/acme/app",
      "cache ttl?",
    );
  });

  it('returns "" and never queries when the prompt is empty/whitespace', async () => {
    const deps = makeDeps();
    expect(await userPromptSubmit({ cwd: "/work/acme/app", prompt: "   " }, deps)).toBe("");
    expect(await userPromptSubmit({ cwd: "/work/acme/app" }, deps)).toBe("");
    expect(deps.getContextQuery).not.toHaveBeenCalled();
  });

  it('returns "" when denied/none (the scope gate) or on no match (relevance gate)', async () => {
    const denied = makeDeps({ resolveBrain: vi.fn(async () => ({ kind: "denied" })) });
    expect(await userPromptSubmit({ cwd: "/personal", prompt: "q" }, denied)).toBe("");
    expect(denied.getContextQuery).not.toHaveBeenCalled();

    const none = makeDeps({ resolveBrain: vi.fn(async () => ({ kind: "none" })) });
    expect(await userPromptSubmit({ cwd: "/loose", prompt: "q" }, none)).toBe("");

    // Hard relevance gate: the query path returns "" (no match) → inject nothing.
    const noMatch = makeDeps({ getContextQuery: vi.fn(async () => "") });
    expect(await userPromptSubmit({ cwd: "/work/acme/app", prompt: "q" }, noMatch)).toBe("");
  });

  it('returns "" for a missing cwd without touching any dep', async () => {
    const deps = makeDeps();
    expect(await userPromptSubmit({ prompt: "q" }, deps)).toBe("");
    expect(deps.resolveBrain).not.toHaveBeenCalled();
  });
});

describe("buildUserPromptSubmitOutput (#194)", () => {
  it("wraps context as UserPromptSubmit additionalContext (no systemMessage)", () => {
    const out = buildUserPromptSubmitOutput("## Team brain — 1 relevant note(s)\n- x");
    expect(out?.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(out?.hookSpecificOutput.additionalContext).toContain("relevant note");
    expect((out as Record<string, unknown>).systemMessage).toBeUndefined();
  });

  it("returns null for empty/whitespace context (inject nothing)", () => {
    expect(buildUserPromptSubmitOutput("")).toBe(null);
    expect(buildUserPromptSubmitOutput("   \n ")).toBe(null);
  });
});

describe("prompt-capture throttle (#194)", () => {
  it("fires on first capture and after the interval elapses; not before", () => {
    // Never captured → fire.
    expect(shouldCaptureNow({ lastMark: null, now: 1_000_000, intervalMs: 900_000 })).toBe(true);
    // Within the interval → skip.
    expect(shouldCaptureNow({ lastMark: 1_000_000, now: 1_400_000, intervalMs: 900_000 })).toBe(
      false,
    );
    // Interval elapsed → fire.
    expect(shouldCaptureNow({ lastMark: 1_000_000, now: 1_900_000, intervalMs: 900_000 })).toBe(
      true,
    );
    // Disabled (intervalMs <= 0) → never, even with no prior mark.
    expect(shouldCaptureNow({ lastMark: null, now: 1_000_000, intervalMs: 0 })).toBe(false);
  });

  it("parses the interval env: default when unset, explicit value, 0 to disable", () => {
    expect(promptCaptureIntervalMs({})).toBeGreaterThan(0); // default (15m)
    expect(promptCaptureIntervalMs({ COMMONWEALTH_PROMPT_CAPTURE_MS: "60000" })).toBe(60_000);
    expect(promptCaptureIntervalMs({ COMMONWEALTH_PROMPT_CAPTURE_MS: "0" })).toBe(0);
    // Garbage → fall back to the default rather than NaN.
    expect(promptCaptureIntervalMs({ COMMONWEALTH_PROMPT_CAPTURE_MS: "nope" })).toBeGreaterThan(0);
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
    expect(result).toEqual({
      captured: 1,
      notes: [{ kind: "memory", title: "T", promoted: true }],
    });
  });

  it("skips (no brain — none) and NEVER extracts or captures, but leaves a receipt (#96)", async () => {
    const deps = makeDeps({ resolveBrain: vi.fn(async () => ({ kind: "none" })) });
    const result = await sessionEnd({ cwd: "/x", transcript_path: "/tmp/t.jsonl" }, deps);
    expect(result).toEqual({ skipped: true, reason: "no-brain" });
    expect(deps.extractCandidates).not.toHaveBeenCalled();
    expect(deps.capture).not.toHaveBeenCalled();
    // A receipt for THIS cwd is saved so the next SessionStart can explain the silence.
    expect(deps.saveReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/x", message: expect.stringContaining("no team brain") }),
    );
  });

  it("skips (out of scope — denied) and NEVER extracts or captures, but leaves a receipt", async () => {
    const deps = makeDeps({ resolveBrain: vi.fn(async () => ({ kind: "denied" })) });
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

  it("leaves a titled receipt naming what was remembered after a real capture (#204)", async () => {
    const deps = makeDeps();
    await sessionEnd({ cwd: "/work/acme/app", transcript_path: "/tmp/t.jsonl" }, deps);
    expect(deps.saveReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/work/acme/app",
        // Past-tense "remembered" (autoPromote on) naming the note title, not a bare count.
        message: expect.stringContaining('remembered from the last session:\n• "T"'),
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
        resolveBrain: vi.fn(async (cwd: string) =>
          cwd === "/work/acme/app" ? { kind: "brain", brain: "/brains/acme" } : { kind: "none" },
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
      expect(result).toEqual({
        captured: 1,
        notes: [{ kind: "memory", title: "T", promoted: true }],
      });
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
      const deps = makeDeps({ resolveBrain: vi.fn(async () => ({ kind: "none" })) });
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
        resolveBrain: vi.fn(async (cwd: string) =>
          cwd === "/work/acme/app" ? { kind: "brain", brain: "/brains/acme" } : { kind: "none" },
        ),
      });
      const result = await sessionEnd(
        { cwd: "/synthetic/rate-limit-pty-cwd", transcript_path: "/tmp/t.jsonl" },
        deps,
      );
      expect(deps.capture).toHaveBeenCalledWith("/brains/acme", "/work/acme/app", [
        { kind: "memory", title: "T", body: "B" },
      ]);
      expect(result).toEqual({
        captured: 1,
        notes: [{ kind: "memory", title: "T", promoted: true }],
      });
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

describe("endReceiptMessage titled receipt (#204)", () => {
  it("names promoted notes in the past tense and points at status", () => {
    const msg = endReceiptMessage({
      captured: 2,
      notes: [
        { kind: "decision", title: "Chose Productive over Harvest", promoted: true },
        { kind: "memory", title: "Staging deploys need the VPN", promoted: true },
      ],
    });
    expect(msg).toContain("remembered from the last session:");
    expect(msg).toContain('• "Chose Productive over Harvest"');
    expect(msg).toContain('• "Staging deploys need the VPN"');
    expect(msg).toContain("commonwealth status");
    expect(msg).not.toContain("(+"); // both fit under the limit
  });

  it("nudges toward /commonwealth:promote when notes are staged (autoPromote off)", () => {
    const msg = endReceiptMessage({
      captured: 1,
      notes: [{ kind: "memory", title: "Prefer pnpm over npm", promoted: false }],
    });
    expect(msg).toContain("staged 1 note(s) from the last session for review:");
    expect(msg).toContain('• "Prefer pnpm over npm"');
    expect(msg).toContain("/commonwealth:promote");
  });

  it("caps the list at 3 titles and collapses the rest into (+N more)", () => {
    const notes = ["a", "b", "c", "d", "e"].map((t) => ({
      kind: "memory",
      title: t,
      promoted: true,
    }));
    const msg = endReceiptMessage({ captured: 5, notes });
    expect(msg).toContain('• "a"');
    expect(msg).toContain('• "c"');
    expect(msg).not.toContain('• "d"');
    expect(msg).toContain("(+2 more)");
  });

  it("falls back to the bare count when no structured notes are present", () => {
    expect(endReceiptMessage({ captured: 2 })).toContain("2 note(s)");
  });
});

describe("parseCaptureLines (#204)", () => {
  it("parses staged lines into kind + title (not promoted)", () => {
    const notes = parseCaptureLines("mem-abc123  [memory]  JWT expiry is 15m");
    expect(notes).toEqual([{ kind: "memory", title: "JWT expiry is 15m", promoted: false }]);
  });

  it("parses promoted lines (path prefix) and flags them promoted", () => {
    const notes = parseCaptureLines(
      "promoted  decisions/dec-x.md  [decision]  Chose Productive over Harvest",
    );
    expect(notes).toEqual([
      { kind: "decision", title: "Chose Productive over Harvest", promoted: true },
    ]);
  });

  it("keeps titles that contain brackets by keying off the first (kind) bracket", () => {
    const notes = parseCaptureLines("mem-1  [memory]  Use [[wikilinks]] for refs");
    expect(notes[0]).toEqual({
      kind: "memory",
      title: "Use [[wikilinks]] for refs",
      promoted: false,
    });
  });

  it("skips blank and unparseable lines", () => {
    const notes = parseCaptureLines("\n  \ngarbage with no bracket\nmem-2  [memory]  Real one\n");
    expect(notes).toEqual([{ kind: "memory", title: "Real one", promoted: false }]);
  });

  it("returns [] for non-string input", () => {
    expect(parseCaptureLines(undefined as unknown as string)).toEqual([]);
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

describe("launchCaptureWorker (#190 — detached so `/clear` teardown can't kill capture)", () => {
  it("spawns a detached, unref'd worker with the hook JSON as a single argv element", async () => {
    const fakeChild = { unref: vi.fn() };
    const spawnFn = vi.fn(() => fakeChild);

    const child = await launchCaptureWorker('{"cwd":"/w","reason":"clear"}', {
      workerPath: "/plugin/hooks/capture-worker.mjs",
      nodeBin: "/usr/bin/node",
      spawnFn,
    });

    expect(child).toBe(fakeChild);
    expect(fakeChild.unref).toHaveBeenCalledOnce();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, argv, opts] = spawnFn.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(cmd).toBe("/usr/bin/node");
    // Transcript is NOT in argv (it's read from transcript_path by the worker) — only the tiny
    // hook JSON is, as one element, so there is no E2BIG risk.
    expect(argv).toEqual(["/plugin/hooks/capture-worker.mjs", '{"cwd":"/w","reason":"clear"}']);
    // detached: true → own process group (setsid), immune to the old session's teardown signals.
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe("ignore");
  });

  it("returns null and never spawns when no workerPath is given", async () => {
    const spawnFn = vi.fn();
    const child = await launchCaptureWorker("{}", { spawnFn });
    expect(child).toBeNull();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("serializes a non-string input to JSON for the worker argv", async () => {
    const spawnFn = vi.fn(() => ({ unref: vi.fn() }));
    await launchCaptureWorker({ cwd: "/w", reason: "clear" }, { workerPath: "/w.mjs", spawnFn });
    const argv = spawnFn.mock.calls[0][1] as string[];
    expect(JSON.parse(argv[1])).toEqual({ cwd: "/w", reason: "clear" });
  });

  it("returns null instead of throwing when the spawn fails (a hook must never break)", async () => {
    const spawnFn = vi.fn(() => {
      throw new Error("EPERM");
    });
    const child = await launchCaptureWorker("{}", { workerPath: "/w.mjs", spawnFn });
    expect(child).toBeNull();
  });
});
