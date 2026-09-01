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

/** Entries that don't count as "pre-existing content" when deciding to abort. */
const IGNORED_ENTRIES = new Set([".git", ".gitkeep"]);

/** Top-level files/folders a Commonwealth brain owns; their presence means "already a brain". */
const BRAIN_ENTRIES = new Set<string>([
  ".commonwealth",
  ".gitattributes",
  ".gitignore",
  ".obsidian",
  ".github",
  "COMMONWEALTH.md",
  // A hand-written README is normal in a git repo, and `initBrain` scaffolds a starter one — so a
  // directory holding only a README is still safe to initialize rather than "someone else's folder".
  "README.md",
  "index",
  ...KIND_DIRS,
]);

// The root hub union-merges (append-only-ish); per-project MOCs carry arbitrary names and are simply
// regenerated after any merge (ADR-0003), so they need no merge driver.
const GITATTRIBUTES = ["COMMONWEALTH.md merge=union", ""].join("\n");

// A commented-out sample so `promote --pr` (#215) teams can gate sensitive canon behind a lead's
// review with one uncomment. Off by default — an active CODEOWNERS rule with no owner set would
// block every PR. Recognized by GitHub/GitLab at `.github/CODEOWNERS`.
const CODEOWNERS = [
  "# Commonwealth CODEOWNERS — require a lead's review on `promote --pr` for sensitive paths.",
  "# Uncomment and set an owner (a @user or @org/team) to gate decisions/ behind review:",
  "# decisions/ @your-org/leads",
  "",
].join("\n");

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
  // Obsidian per-user workspace/session state (P4): the SHARED view config (app/graph/appearance)
  // is committed so the whole team gets the same brain view, but per-user layout/session is not.
  ".obsidian/workspace.json",
  ".obsidian/workspace-mobile.json",
  "",
].join("\n");

/**
 * The starter `README.md` written into a new brain — the file a person lands on when they open the
 * repo on GitHub or the vault in Obsidian, explaining what this folder is before they know the tool.
 * USER-OWNED, unlike `COMMONWEALTH.md`: written absent-only and excluded from the derived-file
 * predicate (`isDerivedMarkdownFile`), so verify never diffs it and `regenerateDerived` never prunes
 * it. Previously a hand-written README classified as derived and reported permanent drift, failing
 * the generated CI gate on every push.
 */
function readmeContent(name: string): string {
  return [
    `# ${name}`,
    "",
    "> **This README is yours.** Commonwealth wrote it once at `init` and will never regenerate,",
    "> overwrite, or diff it again — edit it freely, or replace it entirely.",
    "",
    `**${name}** is a Commonwealth brain: a git-backed markdown second brain for the team. Every fact,`,
    "decision, and piece of in-flight context lives here as a small plain-markdown file that agents",
    "read *before* acting and write back to afterwards — so what one person (or one session) learns is",
    "available to everyone next time. There is no database to lose: the markdown IS the source of",
    "truth, and everything else is derived and rebuildable. This folder is also an Obsidian vault —",
    "open it in Obsidian and the graph, wikilinks, and kind colors work out of the box.",
    "",
    "## What's in here",
    "",
    "Four kinds of note:",
    "",
    "| Kind | Holds |",
    "| --- | --- |",
    "| `memory` | Durable facts and learnings — how something works, why it broke, what was tried |",
    "| `decisions` | Team and business decisions: what was decided, when, by whom, and why |",
    "| `work-state` | In-flight context — what is underway right now, and where it stands |",
    "| `people` | Who is who: roles, responsibilities, and areas of ownership |",
    "",
    "Notes are grouped per project, with a shared bucket for anything unattributed:",
    "",
    "```",
    "<project>/memory|decisions|work-state/   notes for one project",
    "memory|decisions|work-state/             unattributed notes",
    "people/                                  people notes",
    "COMMONWEALTH.md                          generated hub — start reading here",
    "<project>/<project>.md                   generated map-of-content per project",
    "```",
    "",
    "## Generated vs. yours",
    "",
    "`COMMONWEALTH.md` and the per-project map-of-content files are **generated from the notes** and",
    "regenerated on every sync — never hand-edit them; edit the underlying note instead. `index/` and",
    "`staging/` are local-only and gitignored: a disposable search index and your personal review",
    "queue. Everything else — the notes, and this README — is hand-owned and safe to edit.",
    "",
    "## Working with the brain",
    "",
    "| Command | Does |",
    "| --- | --- |",
    "| `commonwealth recall <topic>` | Pull the knowledge relevant to what you're about to do |",
    "| `commonwealth ask <question>` | Get a cited answer synthesized from the notes |",
    "| `commonwealth map` | See the shape of the brain: projects, kinds, coverage |",
    "| `commonwealth status` | Pending review queue and sync state |",
    "| `commonwealth doctor` | Diagnose a brain that isn't behaving |",
    "| `commonwealth verify-restore` | Prove the brain restores cleanly from git (the CI gate) |",
    "",
    "Inside Claude Code, the same surface is available as slash commands: `/commonwealth:recall`,",
    "`/commonwealth:ask`, `/commonwealth:remember`, `/commonwealth:decide`, `/commonwealth:status`,",
    "and `/commonwealth:promote` to approve staged notes into canon.",
    "",
    "## A note on sensitive material",
    "",
    "This brain may describe production systems, customers, and commercial terms. **Describe secrets,",
    'never quote them** — write "the API key lives in 1Password under X", not the key itself.',
    "Commonwealth scans for credentials before every commit, but the scanner is a safety net, not a",
    "license to paste.",
    "",
  ].join("\n");
}

// Starter Obsidian vault config committed with a brain (P4/P5) so opening the folder in Obsidian
// "just works": the graph hides derived/local dirs and colors nodes by kind, and long derived files
// wrap. Written absent-only, so a user's own tweaks are never clobbered on re-init.
const OBSIDIAN_APP = { readableLineLength: true, showLineNumber: false } as const;
const OBSIDIAN_APPEARANCE = { baseFontSize: 16 } as const;
const OBSIDIAN_GRAPH = {
  // Keep derived/local/config dirs out of the graph so the knowledge structure stays legible (P4).
  search: "-path:staging -path:index -path:.commonwealth -path:.obsidian -path:.github",
  showTags: false,
  showAttachments: false,
  hideUnresolved: false,
  showOrphans: true,
  "collapse-filter": true,
  "collapse-color-groups": false,
  // Cluster by note kind (P5) — one color per kind folder, matching both the flat root and
  // per-project subtrees (`path:memory/` hits `memory/` and `<project>/memory/`).
  colorGroups: [
    { query: "path:decisions/", color: { a: 1, rgb: 14722879 } }, // amber
    { query: "path:memory/", color: { a: 1, rgb: 4886233 } }, // blue
    { query: "path:work-state/", color: { a: 1, rgb: 5744730 } }, // green
    { query: "path:people/", color: { a: 1, rgb: 10510294 } }, // purple
  ],
  "collapse-display": false,
  showArrow: false,
  textFadeMultiplier: 0,
  nodeSizeMultiplier: 1,
  lineSizeMultiplier: 1,
  "collapse-forces": false,
  centerStrength: 0.5,
  repelStrength: 10,
  linkStrength: 1,
  linkDistance: 250,
  scale: 1,
  close: false,
} as const;

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
 * Anything else (a source tree, someone's documents, etc.) means initializing here would be a
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
 *   - a generated `COMMONWEALTH.md` router (per-project MOCs are generated by regenerateDerived)
 *   - a starter, USER-OWNED `README.md` (absent-only; never regenerated, pruned, or diffed after)
 *   - a starter `.obsidian/` vault config (shared graph view: kind colors, derived dirs filtered)
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

  // Kind folders, each tracked-empty via .gitkeep. Per-project MOCs (P1) are generated by
  // regenerateDerived at the project-folder root — no per-kind index placeholder is written here.
  for (const kindDir of KIND_DIRS) {
    const abs = path.join(dir, kindDir);
    await fs.mkdir(abs, { recursive: true });
    await writeFile(path.join(abs, ".gitkeep"), "");
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

  // Obsidian vault config (P4/P5): a shared graph view (kind-colored, derived/local dirs filtered)
  // so opening the brain folder in Obsidian is immediately useful. Absent-only — never clobbers a
  // user's own Obsidian tweaks on re-init.
  await writeFileIfAbsent(
    path.join(dir, ".obsidian", "app.json"),
    `${JSON.stringify(OBSIDIAN_APP, null, 2)}\n`,
  );
  await writeFileIfAbsent(
    path.join(dir, ".obsidian", "appearance.json"),
    `${JSON.stringify(OBSIDIAN_APPEARANCE, null, 2)}\n`,
  );
  await writeFileIfAbsent(
    path.join(dir, ".obsidian", "graph.json"),
    `${JSON.stringify(OBSIDIAN_GRAPH, null, 2)}\n`,
  );
  // Commented-out CODEOWNERS sample (#215): teams using `promote --pr` uncomment one line to gate
  // decisions/ behind a lead's review. Absent-only so a team that filled it in is never clobbered.
  await writeFileIfAbsent(path.join(dir, ".github", "CODEOWNERS"), CODEOWNERS);

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

  // Starter README — the human entry point, in contrast to the generated COMMONWEALTH.md router.
  // Absent-only, and never regenerated afterwards: brains predating this scaffold already carry a
  // hand-written README, and every team edits theirs. Overwriting one would destroy real work.
  await writeFileIfAbsent(path.join(dir, "README.md"), readmeContent(name));

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
