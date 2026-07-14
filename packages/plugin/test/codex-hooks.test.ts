import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { codexCaptureMarkKey, codexCapturePayload, runCodexHook } from "../hooks/codex-hook.mjs";

const hookEntry = fileURLToPath(new URL("../hooks/codex-hook.mjs", import.meta.url));

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    resolveBrain: vi.fn(async () => ({ kind: "brain", brain: "/brains/acme" })),
    getContext: vi.fn(async () => "## Team brain — 1 relevant note(s)\n- session context"),
    getContextQuery: vi.fn(async () => "## Team brain — 1 relevant note(s)\n- prompt context"),
    takeReceipt: vi.fn(async () => null),
    readCaptureMark: vi.fn(async () => null),
    writeCaptureMark: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("Codex lifecycle adapter (#225)", () => {
  it("returns Codex-compatible SessionStart and UserPromptSubmit JSON", async () => {
    const deps = makeDeps();
    const start = await runCodexHook("SessionStart", { cwd: "/work/acme" }, { deps });
    expect(start).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: expect.stringContaining("session context"),
      },
    });

    const prompt = await runCodexHook(
      "UserPromptSubmit",
      { cwd: "/work/acme", prompt: "how are JWTs signed?" },
      { deps },
    );
    expect(prompt).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: expect.stringContaining("prompt context"),
      },
    });
    // Prompt capture is intentionally disabled for Codex: Stop captures the completed turn.
    expect(deps.readCaptureMark).not.toHaveBeenCalled();
  });

  it("sanitizes worker argv and forces the Codex host + honest boundary", () => {
    const input = {
      cwd: "/work/acme",
      transcript_path: "/tmp/rollout.jsonl",
      session_id: "s1",
      turn_id: "t1",
      prompt: "x".repeat(10_000),
      last_assistant_message: "private output",
      commonwealth_host: "claude",
      commonwealth_capture_boundary: "session",
    };
    expect(codexCapturePayload(input, "turn")).toEqual({
      cwd: "/work/acme",
      transcript_path: "/tmp/rollout.jsonl",
      session_id: "s1",
      turn_id: "t1",
      commonwealth_host: "codex",
      commonwealth_capture_boundary: "turn",
    });
    expect(codexCaptureMarkKey(input)).toBe("codex:s1");
  });

  it("launches PreCompact once, records the shared mark, then throttles the adjacent Stop", async () => {
    const deps = makeDeps();
    const launchCapture = vi.fn(async () => ({ unref: vi.fn() }));
    const input = {
      cwd: "/work/acme",
      transcript_path: "/tmp/rollout.jsonl",
      session_id: "s1",
      turn_id: "t1",
    };

    expect(
      await runCodexHook("PreCompact", input, {
        deps,
        launchCapture,
        workerPath: "/plugin/capture-worker.mjs",
        now: 1_000,
      }),
    ).toBeNull();
    expect(launchCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        commonwealth_host: "codex",
        commonwealth_capture_boundary: "compaction",
      }),
      { workerPath: "/plugin/capture-worker.mjs" },
    );
    expect(deps.writeCaptureMark).toHaveBeenCalledWith("codex:s1", 1_000);

    deps.readCaptureMark.mockResolvedValue(1_000);
    await runCodexHook("Stop", input, {
      deps,
      launchCapture,
      workerPath: "/plugin/capture-worker.mjs",
      now: 1_001,
      env: { COMMONWEALTH_PROMPT_CAPTURE_MS: "60000" },
    });
    expect(launchCapture).toHaveBeenCalledTimes(1);
  });

  it("launches an eligible Stop with a turn boundary and skips Stop re-entry", async () => {
    const deps = makeDeps();
    const launchCapture = vi.fn(async () => ({ unref: vi.fn() }));
    const input = {
      cwd: "/work/acme",
      transcript_path: "/tmp/rollout.jsonl",
      session_id: "s2",
      turn_id: "t2",
    };

    expect(
      await runCodexHook("Stop", input, {
        deps,
        launchCapture,
        workerPath: "/worker.mjs",
        now: 5_000,
        env: { COMMONWEALTH_PROMPT_CAPTURE_MS: "60000" },
      }),
    ).toBeNull();
    expect(launchCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        commonwealth_host: "codex",
        commonwealth_capture_boundary: "turn",
      }),
      { workerPath: "/worker.mjs" },
    );
    expect(deps.writeCaptureMark).toHaveBeenCalledWith("codex:s2", 5_000);

    await runCodexHook(
      "Stop",
      { ...input, stop_hook_active: true },
      { deps, launchCapture, now: 6_000 },
    );
    expect(launchCapture).toHaveBeenCalledTimes(1);
  });

  it("honors the recursion guard for every event", async () => {
    const deps = makeDeps();
    const launchCapture = vi.fn();
    for (const event of ["SessionStart", "UserPromptSubmit", "PreCompact", "Stop"]) {
      expect(
        await runCodexHook(
          event,
          { cwd: "/work/acme" },
          {
            deps,
            launchCapture,
            env: { COMMONWEALTH_DISABLE_HOOKS: "1" },
          },
        ),
      ).toBeNull();
    }
    expect(deps.resolveBrain).not.toHaveBeenCalled();
    expect(launchCapture).not.toHaveBeenCalled();
  });

  it("treats a failed detached launch as an error for visible diagnostics", async () => {
    await expect(
      runCodexHook(
        "PreCompact",
        { cwd: "/work/acme", session_id: "s3" },
        {
          deps: makeDeps(),
          launchCapture: vi.fn(async () => null),
          workerPath: "/missing-worker.mjs",
        },
      ),
    ).rejects.toThrow("could not launch");
  });

  it("reports malformed input on stderr but exits zero and writes no stdout", async () => {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        const child = spawn(process.execPath, [hookEntry, "Stop"], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
        child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
        child.on("close", (code) => resolve({ code, stdout, stderr }));
        child.stdin.end("not json");
      },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[commonwealth] codex hook error:");
    expect(result.stderr).toContain("not valid JSON");
  });
});
