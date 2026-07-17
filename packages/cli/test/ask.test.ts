import { describe, expect, it } from "vitest";
import { formatAsk, runAsk, type AskEnv } from "../src/ask.js";
import type { AskResult } from "@cmnwlth/core";

/**
 * `commonwealth ask` CLI (ADR-0020). The retrieval itself is covered in core's ask.test.ts; here we
 * assert the CLI resolves a brain, surfaces the cited hits, and — crucially — never fabricates prose
 * (it labels output as retrieval and points synthesis at an agent).
 */
describe("runAsk / formatAsk", () => {
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

  function env(result: AskResult, over: Partial<AskEnv> = {}): AskEnv {
    return {
      cwd: "/project",
      resolveBrain: () => Promise.resolve("/brains/acme"),
      ask: () => Promise.resolve(result),
      ...over,
    };
  }

  it("resolves the brain and returns the retrieval result", async () => {
    let askedBrain: string | null = null;
    const result = await runAsk(
      "why jwt?",
      env(matched, { ask: (b) => ((askedBrain = b), Promise.resolve(matched)) }),
    );
    expect(askedBrain).toBe("/brains/acme");
    expect(result.hits).toHaveLength(1);
  });

  it("throws when no brain resolves", async () => {
    await expect(
      runAsk("why jwt?", env(matched, { resolveBrain: () => Promise.resolve(null) })),
    ).rejects.toThrow(/No Commonwealth brain/);
  });

  it("renders cited hits and points synthesis at an agent — never fabricates prose", async () => {
    const text = formatAsk(matched);
    expect(text).toContain("Chose JWT over sessions");
    expect(text).toContain("decisions/d1.md"); // the citation path
    expect(text).toContain("/commonwealth:ask"); // synthesis happens in an agent
  });

  it("states there isn't enough to answer on thin coverage", async () => {
    const text = formatAsk(thin);
    expect(text).toContain("No notes in the brain matched");
    expect(text).not.toContain("decisions/"); // no citations invented
  });

  // #200: `commonwealth ask` WITHOUT --answer must stay byte-identical to today's retrieval output
  // — synthesis is strictly opt-in. These goldens fail loudly if the default path ever drifts.
  it("default (no --answer) matched output is byte-identical to the retrieval format", () => {
    expect(formatAsk(matched)).toBe(
      "commonwealth ask — why jwt?\n" +
        "\n" +
        "  1 relevant note(s) — cite these when you answer:\n" +
        "\n" +
        "  • Chose JWT over sessions  [decision]\n" +
        "    decisions/d1.md\n" +
        "    stateless API behind the balancer\n" +
        "\n" +
        "Synthesis happens in an agent: run /commonwealth:ask inside Claude Code for a written,\n" +
        "cited answer. Here the CLI shows you the sources to read.\n" +
        "\n",
    );
  });

  it("default (no --answer) thin output is byte-identical to the retrieval format", () => {
    expect(formatAsk(thin)).toBe(
      "commonwealth ask — why kafka?\n" +
        "\n" +
        "  No notes in the brain matched this question.\n" +
        "  There isn't enough captured knowledge to answer it yet.\n" +
        "\n",
    );
  });
});
