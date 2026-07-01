import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { defaultBrainConfig } from "./config.js";
import { KIND_DIR, type NoteKind, SCHEMA_VERSION } from "./schema.js";

const pexec = promisify(execFile);

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
// `.DS_Store` — macOS drops one into every browsed folder; it must never enter the brain.
const GITIGNORE = [
  "index/",
  "staging/",
  "*.db",
  "*.db-shm",
  "*.db-wal",
  ".DS_Store",
  "",
].join("\n");

/**
 * Make `dir` a git repository with an initial scaffold commit, so the brain is operational
 * the moment `initBrain` returns. A Commonwealth brain *is* a git repo (ADR-0003) — the sync
 * engine's `git add -A` / `commit` / `push` and `git remote add origin` all assume one exists;
 * without it, every git command run inside the brain walks up to the nearest ancestor `.git`
 * and operates on the wrong repository (issue #66, ADR-0013).
 *
 * - No-op when `.git` already exists, so a caller that set up its own repo (e.g. a `git clone`
 *   of an existing brain, as the sync fixtures do) is respected and idempotency is preserved.
 * - Falls back to a generic committer identity only when the user has none configured, so the
 *   initial commit succeeds on a fresh machine / CI runner without overriding a real identity.
 * - Best-effort: git being absent or failing must not prevent scaffolding a valid brain — we
 *   degrade to the previous "files only" behavior (never worse than before) rather than throw.
 */
async function initGitRepo(dir: string): Promise<void> {
  if (existsSync(path.join(dir, ".git"))) return;
  try {
    await pexec("git", ["init", "-q", "-b", "main", dir]);
    await pexec("git", ["add", "-A"], { cwd: dir });
    let identity: string[] = [];
    try {
      const email = (await pexec("git", ["config", "user.email"], { cwd: dir })).stdout.trim();
      if (email.length === 0) throw new Error("no identity");
    } catch {
      identity = ["-c", "user.name=Commonwealth", "-c", "user.email=commonwealth@localhost"];
    }
    await pexec("git", [...identity, "commit", "-q", "-m", "Initialize Commonwealth brain scaffold"], {
      cwd: dir,
    });
  } catch {
    // git missing / too old / commit failed — leave the scaffolded files as-is.
  }
}

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
 *   - a git repository with an initial commit (a brain *is* a git repo; ADR-0003, ADR-0013)
 *
 * Idempotent: safe to call again; missing files are (re)created and an existing `.git` is left
 * untouched. Throws if `dir` already contains non-Commonwealth files and `force` is not set.
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

  // A brain is a git repo: init + initial commit so the sync engine has one to operate on
  // (issue #66). No-op if `.git` already exists; best-effort if git is unavailable.
  await initGitRepo(dir);
}

// Re-export for consumers that want the canonical folder list without touching schema.
export const BRAIN_KIND_DIRS: readonly string[] = KIND_DIRS;
export type { NoteKind };
