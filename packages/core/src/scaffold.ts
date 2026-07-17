import { execFile } from "node:child_process";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { defaultBrainConfig } from "./config.js";
import { KIND_DIR, SCHEMA_VERSION } from "./schema.js";

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
// `.commonwealth/sync.lock` is a per-process runtime lock (#100); like `index/` it is disposable
// local state that must never be committed — otherwise a bulk op (e.g. `project adopt`) that holds
// the lock while it `git add -A`s would sweep it into the commit and leave the tree dirty after.
// `.DS_Store` — macOS drops one into every browsed folder; it must never enter the brain.
const GITIGNORE = [
  "index/",
  "staging/",
  ".commonwealth/sync.lock",
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
    await pexec(
      "git",
      [...identity, "commit", "-q", "-m", "Initialize Commonwealth brain scaffold"],
      {
        cwd: dir,
      },
    );
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
  // A directory that is ALREADY a brain (has the identity file) is always safe to re-init:
  // initBrain is idempotent and no longer overwrites config (ADR-0013/#75), so re-scaffolding
  // for a reseed is a no-op on existing state. This lets `commonwealth init --reseed` run on a
  // populated brain whose root also holds runtime entries (`staging/`, `.DS_Store`, and the
  // per-project note folders from ADR-0015) that predate/aren't in BRAIN_ENTRIES (#61-followup).
  if (existsSync(path.join(dir, ".commonwealth", "schema-version"))) return true;

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
 * Write `contents` to `file` only if it does not already exist (creating parent dirs). Used for
 * files that hold real, team-modifiable state (`config.json`, the schema-version pin, the git
 * driver files) so a re-init / `--reseed` on an existing brain never clobbers settings the team
 * changed — e.g. `remotes`, `curation`, or a `false` `autoPromote` (#75). Uses the `wx` open flag
 * (fail-if-exists) so the check-and-write is a single atomic syscall, not a TOCTOU race.
 */
async function writeFileIfAbsent(file: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, contents, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return;
    throw err;
  }
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

  // .commonwealth metadata: schema-version pin + config.json. Written only when absent so a
  // re-init never resets a brain the team already configured (#75): config.json is real,
  // team-owned data (remotes/curation/autoPromote), recoverable only via git archaeology.
  await writeFileIfAbsent(path.join(dir, ".commonwealth", "schema-version"), `${SCHEMA_VERSION}\n`);
  const config = defaultBrainConfig(name);
  await writeFileIfAbsent(
    path.join(dir, ".commonwealth", "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  );

  // Git merge/ignore drivers for derived + disposable artifacts (ADR-0003, ADR-0005). Also
  // absent-only: they're static, but re-writing them serves no purpose and keeps init a no-op.
  await writeFileIfAbsent(path.join(dir, ".gitattributes"), GITATTRIBUTES);
  await writeFileIfAbsent(path.join(dir, ".gitignore"), GITIGNORE);

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

/** Repo-relative path of the generated GitHub Actions disaster-recovery workflow (#220). */
export const CI_WORKFLOW_REL = path.join(".github", "workflows", "commonwealth-ci.yml");

/**
 * The CLI major version this package is released in lockstep with, e.g. `"0"` for `0.1.11`. Read
 * from this package's own package.json — the whole monorepo version-bumps together (see the
 * release commits), so core's major always equals `@cmnwlth/cli`'s major. Used to pin the workflow
 * to a compatible CLI line (`npx @cmnwlth/cli@<major>`) so a future breaking release can't silently
 * change what runs in a team's CI. Falls back to `"0"` if the version can't be read.
 */
export function cliMajorPin(): string {
  try {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    const major = typeof pkg.version === "string" ? pkg.version.split(".")[0] : undefined;
    return major && /^\d+$/.test(major) ? major : "0";
  } catch {
    return "0";
  }
}

/**
 * The `commonwealth-ci.yml` workflow body, pinned to CLI major `pin`. On every push/PR it clones
 * the brain from its `origin` remote and runs `verify-restore --from-remote --json` (#136) — the
 * CI-ready disaster-recovery proof that fails, naming the exact offending note, when a corrupted
 * note / broken supersede chain / index drift is pushed. `COMMONWEALTH_BRAIN_DIR` points the CLI at
 * the checked-out workspace so it resolves the brain without a registry mapping on the runner.
 */
export function ciWorkflowContent(pin = cliMajorPin()): string {
  return [
    "# Generated by `commonwealth init --remote <url>` (#220). Commonwealth's continuous",
    "# disaster-recovery gate: on every push / PR it clones the brain from its remote and proves a",
    "# full restore (verify-restore --from-remote), so a corrupted note, broken supersede chain, or",
    "# index drift is caught AT PUSH TIME — naming the exact failing file — instead of at read time.",
    "#",
    "# Safe to edit: re-running `commonwealth init` will NOT overwrite this file once it exists.",
    `# Pinned to CLI major @${pin} so a future breaking release can't silently change the gate.`,
    "name: commonwealth-ci",
    "",
    "on:",
    "  push:",
    "  pull_request:",
    "",
    "jobs:",
    "  verify-restore:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: actions/setup-node@v4",
    "        with:",
    '          node-version: "22"',
    "      - name: Verify disaster recovery (clone + restore + checks)",
    "        env:",
    "          COMMONWEALTH_BRAIN_DIR: ${{ github.workspace }}",
    `        run: npx --yes @cmnwlth/cli@${pin} verify-restore --from-remote --json`,
    "",
  ].join("\n");
}

/** Outcome of {@link scaffoldCiWorkflow}. */
export interface CiWorkflowResult {
  /** Absolute path of the workflow file (whether written now or pre-existing). */
  path: string;
  /** True when this call wrote the file; false when it was skipped. */
  written: boolean;
  /** Why the write was skipped (`exists` when a user-modifiable file was already there). */
  skipped?: "exists";
}

/**
 * Write the `commonwealth-ci.yml` disaster-recovery workflow into `brainDir` (#220). Emit-style
 * idempotency (like `commonwealth emit`): if the file already exists it is LEFT UNTOUCHED — a team
 * may have customized it — and the result reports `skipped: "exists"`. Otherwise the pinned
 * workflow is written. The `wx` open flag makes the check-and-write a single atomic syscall (no
 * TOCTOU). Only meaningful for a brain with a remote (CI has nothing to clone otherwise); callers
 * gate on that and on the `--no-ci` opt-out.
 */
export async function scaffoldCiWorkflow(
  brainDir: string,
  opts: { pin?: string } = {},
): Promise<CiWorkflowResult> {
  const file = path.join(brainDir, CI_WORKFLOW_REL);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, ciWorkflowContent(opts.pin), { encoding: "utf8", flag: "wx" });
    return { path: file, written: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return { path: file, written: false, skipped: "exists" };
    }
    throw err;
  }
}
