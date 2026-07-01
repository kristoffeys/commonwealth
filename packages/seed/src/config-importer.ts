import { promises as fs } from "node:fs";
import path from "node:path";
import type { NewNoteInput } from "@commons/core";

/** Max characters retained from any imported config file. */
const BODY_CAP = 4000;

/**
 * Fixed agent-config paths to import when present, relative to the repo root. Order here
 * is the tiebreak base; final output is re-sorted by path for determinism.
 */
const FIXED_CONFIG_PATHS = [
  "CLAUDE.md",
  ".cursorrules",
  "AGENTS.md",
  path.join(".github", "copilot-instructions.md"),
];

/** Directory of extra rule files to glob (each `*.md` becomes its own note). */
const RULES_DIR = path.join(".claude", "rules");

/** Cap a string to {@link BODY_CAP} characters after trimming. */
function capBody(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > BODY_CAP ? trimmed.slice(0, BODY_CAP) : trimmed;
}

/** Collect the set of relative config paths that exist under `repoDir`, sorted. */
async function collectConfigPaths(repoDir: string): Promise<string[]> {
  const found: string[] = [];

  for (const rel of FIXED_CONFIG_PATHS) {
    try {
      const stat = await fs.stat(path.join(repoDir, rel));
      if (stat.isFile()) found.push(rel);
    } catch {
      // Missing file — skip silently.
    }
  }

  try {
    const entries = await fs.readdir(path.join(repoDir, RULES_DIR));
    for (const name of entries) {
      if (name.toLowerCase().endsWith(".md")) {
        found.push(path.join(RULES_DIR, name));
      }
    }
  } catch {
    // No rules dir — skip silently.
  }

  // Deterministic ordering, sorted by relative path.
  return [...new Set(found)].sort();
}

/**
 * Import agent-config files from a repo into `memory` candidate notes. Looks for
 * `CLAUDE.md`, `.cursorrules`, `AGENTS.md`, `.github/copilot-instructions.md`, and any
 * `.claude/rules/*.md`. Missing files are skipped silently. Output is deterministic,
 * sorted by relative path. Each note's title is the file's first `# ` heading if present,
 * otherwise `Project config: <filename>`; the body is the file content (capped).
 *
 * @param repoDir Absolute path to the repository to scan.
 * @returns One `memory` candidate per config file found, tagged `["config", "seed"]`.
 */
export async function importConfigs(repoDir: string): Promise<NewNoteInput[]> {
  const relPaths = await collectConfigPaths(repoDir);

  const notes: NewNoteInput[] = [];
  for (const rel of relPaths) {
    let content: string;
    try {
      content = await fs.readFile(path.join(repoDir, rel), "utf8");
    } catch {
      continue;
    }
    const filename = path.basename(rel);
    const headingMatch = content.match(/^#\s+(.+)$/m);
    const title = headingMatch ? headingMatch[1]!.trim() : `Project config: ${filename}`;
    notes.push({
      kind: "memory",
      title,
      body: capBody(content),
      tags: ["config", "seed"],
    });
  }
  return notes;
}
