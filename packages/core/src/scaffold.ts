import { promises as fs } from "node:fs";
import path from "node:path";
import { defaultBrainConfig } from "./config.js";
import { KIND_DIR, type NoteKind, SCHEMA_VERSION } from "./schema.js";

export interface InitBrainOptions {
  /** Human-readable brain name, written into COMMONWEALTH.md / .commonwealth/config. */
  name?: string;
  /** Proceed even if the directory already contains files. */
  force?: boolean;
}

/** The four kind folders, in stable order, each tracked empty via a `.gitkeep`. */
const KIND_DIRS: readonly string[] = Object.values(KIND_DIR);

/** Human-readable heading label for each kind folder's `INDEX.md`. */
const KIND_INDEX_TITLE: Record<string, string> = {
  memory: "Memory",
  decisions: "Decisions",
  "work-state": "Work-state",
  people: "People",
};

/** Entries that don't count as "pre-existing content" when deciding to abort. */
const IGNORED_ENTRIES = new Set([".git", ".gitkeep"]);

/** Top-level files/folders a Commonwealth brain owns; their presence means "already a brain". */
const BRAIN_ENTRIES = new Set<string>([
  ".commonwealth",
  ".gitattributes",
  ".gitignore",
  "COMMONWEALTH.md",
  "index",
  ...KIND_DIRS,
]);

const GITATTRIBUTES = ["COMMONWEALTH.md merge=union", "**/INDEX.md merge=union", ""].join("\n");

// `staging/` is the per-user review queue — local only, never synced (ADR-0008).
const GITIGNORE = ["index/", "staging/", "*.db", "*.db-shm", "*.db-wal", ""].join("\n");

/**
 * True if `dir` is empty or contains only entries a Commonwealth brain owns (or `.git`).
 * Anything else (a stray README, source tree, etc.) means initializing here would be a
 * surprise, so `initBrain` refuses unless `force` is set.
 */
async function isSafeToInit(dir: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return true; // dir doesn't exist yet — we'll create it
  }
  for (const entry of entries) {
    if (IGNORED_ENTRIES.has(entry)) continue;
    if (!BRAIN_ENTRIES.has(entry)) return false;
  }
  return true;
}

/** Write `contents` to `file` (creating parent dirs). Overwrites — the skeleton is generated. */
async function writeFile(file: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents, "utf8");
}

/**
 * Initialize a brain repository skeleton at `dir` (see docs/01-architecture.md §1,
 * docs/02-data-model.md). Creates:
 *   - the four kind folders: memory/ decisions/ work-state/ people/ (each with `.gitkeep`)
 *   - `.commonwealth/` with `schema-version` and a `config.json` (name, schemaVersion, remotes, curation)
 *   - `.gitattributes` with `merge=union` for derived/append-only files (ADR-0003)
 *   - `.gitignore` ignoring the derived `index/` and `*.db`
 *   - a generated `COMMONWEALTH.md` router and per-folder `INDEX.md` placeholders
 *
 * Idempotent: safe to call again; missing files are (re)created. Throws if `dir` already
 * contains non-Commonwealth files and `force` is not set.
 */
export async function initBrain(dir: string, opts: InitBrainOptions = {}): Promise<void> {
  if (!opts.force && !(await isSafeToInit(dir))) {
    throw new Error(
      `Refusing to initialize a Commonwealth brain in a non-empty directory: ${dir}. ` +
        `Pass { force: true } to proceed.`,
    );
  }

  const name = opts.name ?? path.basename(path.resolve(dir));

  await fs.mkdir(dir, { recursive: true });

  // Kind folders, each tracked-empty via .gitkeep, plus a per-folder INDEX.md placeholder.
  for (const kindDir of KIND_DIRS) {
    const abs = path.join(dir, kindDir);
    await fs.mkdir(abs, { recursive: true });
    await writeFile(path.join(abs, ".gitkeep"), "");
    const title = KIND_INDEX_TITLE[kindDir] ?? kindDir;
    await writeFile(path.join(abs, "INDEX.md"), `# ${title} index\n\n_generated_\n`);
  }

  // .commonwealth metadata: schema-version pin + config.json.
  await writeFile(path.join(dir, ".commonwealth", "schema-version"), `${SCHEMA_VERSION}\n`);
  const config = defaultBrainConfig(name);
  await writeFile(
    path.join(dir, ".commonwealth", "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  );

  // Git merge/ignore drivers for derived + disposable artifacts (ADR-0003, ADR-0005).
  await writeFile(path.join(dir, ".gitattributes"), GITATTRIBUTES);
  await writeFile(path.join(dir, ".gitignore"), GITIGNORE);

  // Minimal generated router placeholder; real content comes from regenerateDerived.
  const commonwealth = [
    `# ${name} — Commonwealth brain`,
    "",
    "_This file is generated. Do not edit by hand — it is regenerated from the note set._",
    "",
    "Run the Commonwealth index to populate the router with active work-state and recent decisions.",
    "",
  ].join("\n");
  await writeFile(path.join(dir, "COMMONWEALTH.md"), commonwealth);
}

// Re-export for consumers that want the canonical folder list without touching schema.
export const BRAIN_KIND_DIRS: readonly string[] = KIND_DIRS;
export type { NoteKind };
