import { describe, expect, it, vi } from "vitest";
import type { AskResult } from "@cmnwlth/core";
import {
  DISABLE_HOOKS_ENV,
  NOT_ENOUGH,
  buildSynthesisArgs,
  formatAnswer,
  synthesizeAnswer,
  type RunOptions,
  type RunResult,
  type SynthesisEnv,
  type SynthesisHost,
} from "../src/synthesize.js";

/**
 * `commonwealth ask --answer` synthesis (#200, ADR-0020-compatible). The model host is stubbed so
 * no real `claude`/`codex` runs. We assert: the retrieval excerpts + question reach the model;
 * citations render; thin coverage declines WITHOUT a model call; a missing binary errors clearly;
 * and the recursion-guard env is set on the spawn.
 */
describe("synthesizeAnswer / formatAnswer", () => {
  const matched: AskResult = {
    question: "why jwt?",
    hits: [
      {
        id: "d1",
        kind: "decision",
        title: "Chose JWT over sessions",
        path: "decisions/d1.md",
        source: "acme/app",
        excerpt: "stateless API behind the balancer",
      },
    ],
    coverage: { matched: true, topScore: 3.2, total: 1 },
  };
  const thin: AskResult = {
    question: "why kafka?",
    hits: [],
    coverage: { matched: false, topScore: 0, total: 0 },
  };

  interface Call {
    runtime: string;
    args: string[];
    opts: RunOptions;
  }

  function env(host: SynthesisHost | null, result: RunResult, calls: Call[]): SynthesisEnv {
    return {
      detectHost: () => host,
      run: (runtime, args, opts) => {
        calls.push({ runtime, args, opts });
        return Promise.resolve(result);
      },
      timeoutMs: 1000,
      cwd: "/project",
    };
  }

  function ok(stdout: string): RunResult {
    return { code: 0, stdout, stderr: "" };
  }

  it("invokes the host with the excerpts as stdin DATA + the question, and returns the answer", async () => {
    const calls: Call[] = [];
    const synth = await synthesizeAnswer(
      matched,
      env("claude", ok("JWT was chosen for stateless auth (d1 — decisions/d1.md)."), calls),
    );

    expect(calls).toHaveLength(1);
    const [call] = calls;
    // the question rides in the prompt argv
    expect(call.args.some((a) => a.includes("why jwt?"))).toBe(true);
    // the retrieval excerpt + citation anchors ride on stdin as DATA
    expect(call.opts.input).toContain("stateless API behind the balancer");
    expect(call.opts.input).toContain("id: d1");
    expect(call.opts.input).toContain("decisions/d1.md");
    expect(synth.answer).toContain("d1 — decisions/d1.md");
    expect(synth.host).toBe("claude");
  });

  it("renders the answer above its citations", async () => {
    const synth = await synthesizeAnswer(
      matched,
      env("claude", ok("JWT for stateless auth (d1 — decisions/d1.md)."), []),
    );
    const text = formatAnswer(matched, synth);
    expect(text).toContain("JWT for stateless auth");
    expect(text).toContain("Sources (1)");
    expect(text).toContain("d1 — decisions/d1.md");
    expect(text).toContain("Synthesized by claude");
  });

  it("sets the recursion-guard env on the spawn", async () => {
    const calls: Call[] = [];
    await synthesizeAnswer(matched, env("claude", ok("answer (d1 — decisions/d1.md)"), calls));
    expect(calls[0].opts.env).toMatchObject({ [DISABLE_HOOKS_ENV]: "1" });
  });

  it("declines on thin coverage WITHOUT invoking the model (no wasted call)", async () => {
    const run = vi.fn();
    const synth = await synthesizeAnswer(thin, {
      detectHost: () => "claude",
      run,
      timeoutMs: 1000,
      cwd: "/project",
    });
    expect(run).not.toHaveBeenCalled();
    expect(synth.answer).toBe(NOT_ENOUGH);
    expect(synth.host).toBeNull();
    // the decline sentinel renders, and no citations are invented
    const text = formatAnswer(thin, synth);
    expect(text).toContain(NOT_ENOUGH);
    expect(text).not.toContain("decisions/");
  });

  it("errors clearly, naming the flag's requirement, when no host binary is installed", async () => {
    await expect(synthesizeAnswer(matched, env(null, ok(""), []))).rejects.toThrow(
      /--answer needs a headless model CLI/,
    );
  });

  it("errors when the host exits non-zero", async () => {
    await expect(
      synthesizeAnswer(matched, env("claude", { code: 1, stdout: "", stderr: "boom" }, [])),
    ).rejects.toThrow(/exited with code 1/);
  });

  it("builds the claude print-mode argv (free-text, no schema)", () => {
    const args = buildSynthesisArgs("claude", { system: "SYS", prompt: "PROMPT" });
    expect(args).toEqual(["-p", "--append-system-prompt", "SYS", "PROMPT"]);
  });

  it("builds the codex exec argv with developer instructions (exact — drift guard)", () => {
    const args = buildSynthesisArgs("codex", { system: "SYS", prompt: "PROMPT" });
    // Exact match on the full argv: this is the lockstep drift guard for the ported
    // invocation contract (extraction.mjs buildHostArgs) — ANY divergence, including a
    // dropped isolation flag, must fail here rather than ship silently.
    expect(args).toEqual([
      "-a",
      "never",
      "exec",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--color",
      "never",
      "-c",
      'developer_instructions="SYS"',
      "PROMPT",
    ]);
  });
});
