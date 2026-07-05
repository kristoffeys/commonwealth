import path from "node:path";
import { askBrain, resolveBrainDir, type AskResult } from "@cmnwlth/core";

/**
 * `commonwealth ask "<question>"` (ADR-0020, #108). Outside an agent there's no synthesizer, so the
 * CLI degrades HONESTLY to citation-anchored retrieval: it prints the notes that answer the
 * question, each with its id/path, and says synthesis happens in an agent — it never fabricates a
 * prose answer. Inside Claude Code, the `/commonwealth:ask` command + the MCP `ask` tool let the
 * agent write the cited answer.
 */

/** Injectable surfaces so tests run against a fixture brain. */
export interface AskEnv {
  cwd: string;
  resolveBrain: (cwd: string) => Promise<string | null>;
  ask: (brainDir: string, question: string) => Promise<AskResult>;
}

/** Real surfaces (env-pinned brain or registry resolution). */
export function defaultAskEnv(cwd: string): AskEnv {
  const brainEnv = process.env.COMMONWEALTH_BRAIN_DIR;
  return {
    cwd,
    resolveBrain: (dir) =>
      brainEnv && brainEnv.length > 0
        ? Promise.resolve(path.resolve(brainEnv))
        : resolveBrainDir(dir),
    ask: (brainDir, question) => askBrain(brainDir, question),
  };
}

/** Resolve the brain and retrieve cited context for `question`. Throws when no brain resolves. */
export async function runAsk(question: string, env: AskEnv): Promise<AskResult> {
  const brain = await env.resolveBrain(path.resolve(env.cwd));
  if (!brain) {
    throw new Error(
      `No Commonwealth brain resolves for ${env.cwd}. Run \`commonwealth init\` or add a registry mapping.`,
    );
  }
  return env.ask(brain, question);
}

/** Render cited retrieval for the terminal — honestly labeled as retrieval, not synthesis. */
export function formatAsk(result: AskResult): string {
  const lines = [`commonwealth ask — ${result.question}`, ""];
  if (!result.coverage.matched) {
    lines.push(
      "  No notes in the brain matched this question.",
      "  There isn't enough captured knowledge to answer it yet.",
      "",
    );
    return `${lines.join("\n")}\n`;
  }
  lines.push(`  ${result.hits.length} relevant note(s) — cite these when you answer:`, "");
  for (const h of result.hits) {
    lines.push(`  • ${h.title}  [${h.kind}]`);
    lines.push(`    ${h.path}`);
    if (h.excerpt) lines.push(`    ${h.excerpt}`);
    lines.push("");
  }
  lines.push(
    "Synthesis happens in an agent: run /commonwealth:ask inside Claude Code for a written,",
    "cited answer. Here the CLI shows you the sources to read.",
    "",
  );
  return `${lines.join("\n")}\n`;
}
