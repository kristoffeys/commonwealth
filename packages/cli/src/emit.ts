import { promises as fs } from "node:fs";
import path from "node:path";
import {
  emitAgentContext,
  EMIT_BEGIN,
  EMIT_END,
  resolveBrainDir,
  resolveProjectSource,
} from "@cmnwlth/core";

/**
 * `commonwealth emit` (#135) — write the project's team-brain slice into the derived context files
 * Cursor/Codex/Copilot read, so mixed-tool teammates get the brain with zero runtime integration.
 * Two wholly-owned files (`.cursor/rules/commonwealth.mdc`, `.github/instructions/
 * commonwealth.instructions.md`) plus a sentinel-fenced block in `AGENTS.md`. Wholly-owned files
 * are gitignored by default (they'd otherwise churn across machines); `--commit` opts into tracking
 * them. Every file is marked "generated — do not edit".
 *
 * Filesystem surfaces are injected via {@link EmitEnv} so tests run against a temp project.
 */

/** The two wholly-owned files, relative to the project root. AGENTS.md is handled separately. */
const CURSOR_REL = path.join(".cursor", "rules", "commonwealth.mdc");
const COPILOT_REL = path.join(".github", "instructions", "commonwealth.instructions.md");
const AGENTS_REL = "AGENTS.md";

/** Injectable surfaces (defaults in {@link defaultEmitEnv}). */
export interface EmitEnv {
  cwd: string;
  /** Resolve the brain for a cwd. */
  resolveBrain: (cwd: string) => Promise<string | null>;
  /** Resolve the project identity (frontmatter `source`) for a cwd. */
  resolveSource: (cwd: string) => Promise<string | null>;
  /** Render the brain's agent-context block for a project. */
  render: (brainDir: string, projectSource: string) => Promise<string>;
  /** Timestamp stamped into the wholly-owned (gitignored) files. */
  now: () => Date;
}

/** What an emit run wrote. */
export interface EmitResult {
  brain: string;
  projectSource: string;
  /** Project-relative paths written/updated. */
  written: string[];
  /** Whether the wholly-owned files were gitignored (false under `--commit`). */
  gitignored: boolean;
}

/** Real surfaces. */
export function defaultEmitEnv(cwd: string): EmitEnv {
  const brainEnv = process.env.COMMONWEALTH_BRAIN_DIR;
  return {
    cwd,
    resolveBrain: (dir) =>
      brainEnv && brainEnv.length > 0
        ? Promise.resolve(path.resolve(brainEnv))
        : resolveBrainDir(dir),
    resolveSource: (dir) => resolveProjectSource(dir),
    render: (brainDir, projectSource) => emitAgentContext(brainDir, { projectSource }),
    now: () => new Date(),
  };
}

/** Write `content` to `abs`, creating parent dirs. */
async function writeFileMkdir(abs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

/**
 * Replace the `<!-- BEGIN COMMONWEALTH -->…<!-- END COMMONWEALTH -->` block in `existing` with
 * `block`, or append a fresh fenced block. Content outside the sentinels is preserved verbatim —
 * so a user-owned AGENTS.md keeps its own instructions.
 */
export function upsertSentinelBlock(existing: string, block: string): string {
  const fenced = `${EMIT_BEGIN}\n${block.trimEnd()}\n${EMIT_END}`;
  const begin = existing.indexOf(EMIT_BEGIN);
  const end = existing.indexOf(EMIT_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    const before = existing.slice(0, begin);
    const after = existing.slice(end + EMIT_END.length);
    return `${before}${fenced}${after}`.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  }
  const base = existing.trimEnd();
  return base.length > 0 ? `${base}\n\n${fenced}\n` : `${fenced}\n`;
}

/** Ensure each of `rels` appears in the project `.gitignore` (idempotent; created if absent). */
async function ensureGitignored(projectDir: string, rels: string[]): Promise<void> {
  const file = path.join(projectDir, ".gitignore");
  let current = "";
  try {
    current = await fs.readFile(file, "utf8");
  } catch {
    current = "";
  }
  const have = new Set(current.split("\n").map((l) => l.trim()));
  const toAdd = rels.map((r) => r.split(path.sep).join("/")).filter((r) => !have.has(r));
  if (toAdd.length === 0) return;
  const header = current.includes("# Commonwealth generated agent-context")
    ? ""
    : "# Commonwealth generated agent-context (run `commonwealth emit`)\n";
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await fs.writeFile(file, `${current}${prefix}${header}${toAdd.join("\n")}\n`, "utf8");
}

/**
 * Emit the project's brain slice into the derived context files. `commit: true` tracks the
 * wholly-owned files (skips gitignoring them); default gitignores them to avoid cross-machine
 * churn. The AGENTS.md sentinel block is always written in place (it may be user-owned/committed).
 */
export async function runEmit(opts: { commit?: boolean }, env: EmitEnv): Promise<EmitResult> {
  const cwd = path.resolve(env.cwd);
  const brain = await env.resolveBrain(cwd);
  if (!brain) {
    throw new Error(
      `No Commonwealth brain resolves for ${cwd}. Run \`commonwealth init\` or add a registry mapping.`,
    );
  }
  const projectSource = (await env.resolveSource(cwd)) ?? path.basename(cwd);
  const block = await env.render(brain, projectSource);
  const stamp = `<!-- generated by commonwealth emit at ${env.now().toISOString()} — do not edit -->\n`;

  // Cursor MDC: frontmatter (alwaysApply) + the block. Wholly owned.
  const cursor = `---\ndescription: Team brain context for ${projectSource} (generated by Commonwealth)\nalwaysApply: true\n---\n\n${stamp}${block}`;
  await writeFileMkdir(path.join(cwd, CURSOR_REL), cursor);

  // Copilot path-scoped instructions: frontmatter (applyTo) + the block. Wholly owned.
  const copilot = `---\napplyTo: "**"\n---\n\n${stamp}${block}`;
  await writeFileMkdir(path.join(cwd, COPILOT_REL), copilot);

  // AGENTS.md managed block — preserve any user content around the sentinels.
  const agentsAbs = path.join(cwd, AGENTS_REL);
  let existing = "";
  try {
    existing = await fs.readFile(agentsAbs, "utf8");
  } catch {
    existing = "";
  }
  await fs.writeFile(agentsAbs, upsertSentinelBlock(existing, block), "utf8");

  const written = [CURSOR_REL, COPILOT_REL, AGENTS_REL].map((r) => r.split(path.sep).join("/"));
  const gitignored = !opts.commit;
  if (gitignored) await ensureGitignored(cwd, [CURSOR_REL, COPILOT_REL]);

  return { brain, projectSource, written, gitignored };
}

/** One-line-per-file summary for the CLI. */
export function formatEmitResult(result: EmitResult): string {
  const lines = [
    `commonwealth emit — ${result.projectSource}`,
    `  brain: ${result.brain}`,
    "",
    ...result.written.map((w) => `  ✓ ${w}`),
    "",
    result.gitignored
      ? "Wholly-owned files were gitignored (pass --commit to track them). AGENTS.md block written in place."
      : "Files written and tracked (--commit). Commit them to share with teammates.",
    "",
  ];
  return `${lines.join("\n")}\n`;
}
