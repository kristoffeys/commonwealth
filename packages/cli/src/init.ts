import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NewNoteInput } from "@commonwealth/core";

/** Per-source counts of what seeding mined from the repo. */
export interface InitBySource {
  adr: number;
  git: number;
  config: number;
}

/** Flags that shape an `init` run, parsed from the CLI. */
export interface InitOptions {
  /** Explicit brain directory to create/use instead of {@link defaultBrainDir}. */
  brain?: string;
  /** Skip the confirmation prompt and seed non-interactively. */
  yes?: boolean;
  /** Re-run seeding even if this project already resolves to a brain (skip JOIN). */
  reseed?: boolean;
  /** Gather + stage seed candidates. Defaults to `true`; `false` creates the brain but skips staging. */
  seed?: boolean;
}

/**
 * Injected side effects so {@link runInit} is deterministic and unit-testable without
 * touching the filesystem, spawning `commonwealth-curate`, or prompting a human.
 */
export interface InitDeps {
  /** Mine cold-start candidates from the repo (usually `@commonwealth/seed`'s `gatherCandidates`). */
  gather(repoDir: string): Promise<{ candidates: NewNoteInput[]; bySource: InitBySource }>;
  /** Resolve the brain this project already belongs to, or `null` if none. */
  resolveBrain(cwd: string): Promise<string | null>;
  /** Scaffold a fresh brain at `dir` with the given human-readable name. */
  createBrain(dir: string, name: string): Promise<void>;
  /**
   * Record that `repoDir` maps to `brainDir` in the global brain registry (ADR-0011). The
   * registry is the default source of truth; the per-project `.commonwealth/brain` marker
   * remains an optional manual override (`core.setBrainMarker`), not written here.
   */
  registerBrain(repoDir: string, brainDir: string): Promise<void>;
  /** Stage candidates into the brain's review queue; returns how many were captured. */
  stage(brainDir: string, candidates: NewNoteInput[]): Promise<{ captured: number }>;
  /** Ask the user a yes/no question; resolves to their answer. */
  confirm(message: string): Promise<boolean>;
  /** Emit a human-facing line (diagnostics stream, never stdout data). */
  log(message: string): void;
}

/** What an {@link runInit} run did, for the CLI to summarize and tests to assert on. */
export interface InitResult {
  /** `new` = brain created + seeded; `join` = mounted existing brain; `skipped` = created but seeding declined. */
  mode: "new" | "join" | "skipped";
  /** The brain directory this project is now pinned to. */
  brainDir: string;
  /** How many candidate notes were staged into the review queue. */
  staged: number;
  /** How many candidates seeding gathered (0 in JOIN mode). */
  gathered: number;
}

/**
 * Walk up from `startDir` looking for a `.git` directory; return the repo root, or fall
 * back to `startDir` when no `.git` ancestor exists (e.g. a not-yet-initialized project).
 *
 * @param startDir Directory to start the upward search from.
 * @returns The nearest ancestor containing `.git`, else `startDir`.
 */
export function findRepoRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir);
    dir = parent;
  }
}

/**
 * Compute the default brain directory for a project. The brain is a SEPARATE repo living
 * under `~/.commonwealth/brains/<project-basename>`, never nested inside the project itself.
 *
 * @param repoRoot The project's repo root.
 * @returns An absolute path for the project's default brain.
 */
export function defaultBrainDir(repoRoot: string): string {
  return path.join(os.homedir(), ".commonwealth", "brains", path.basename(path.resolve(repoRoot)));
}

/**
 * Orchestrate `commonwealth init`. Deterministic and side-effect-free except through `deps`.
 *
 * Flow: resolve the repo root and any existing brain. If one exists and we're not
 * reseeding, JOIN it (register the mapping, done). Otherwise create a new brain, register
 * the project → brain mapping, gather seed candidates, preview them, and — guarded behind
 * confirmation unless `--yes` — stage them into the review queue. Brain creation and the
 * registry mapping are idempotent and always run; every content write (staging) is gated
 * by `confirm`.
 *
 * @param cwd The directory `commonwealth init` was invoked from.
 * @param opts Parsed CLI flags.
 * @param deps Injected side effects.
 * @returns A structured summary of what happened.
 */
export async function runInit(cwd: string, opts: InitOptions, deps: InitDeps): Promise<InitResult> {
  // The mapping/scope/brain-name base is the INVOCATION dir, not the git root. `findRepoRoot`
  // may climb above `cwd` to a parent repo (a nested package, or a folder-of-repos sitting
  // under a stray parent `.git`); using that as the registry prefix over-scopes every sibling
  // to the wrong brain (#61). The git root stays a separate concern, used only for mining.
  const projectDir = path.resolve(cwd);
  const repoRoot = findRepoRoot(cwd);

  const existing = await deps.resolveBrain(cwd);
  if (existing !== null && !opts.reseed) {
    await deps.registerBrain(projectDir, existing);
    deps.log(`Joined existing brain at ${existing}. Run the sync daemon to pull.`);
    return { mode: "join", brainDir: existing, staged: 0, gathered: 0 };
  }

  const brainDir = opts.brain ?? defaultBrainDir(projectDir);
  await deps.createBrain(brainDir, path.basename(brainDir));
  await deps.registerBrain(projectDir, brainDir);

  if (opts.seed === false) {
    deps.log(`Seeding skipped. Brain created at ${brainDir}.`);
    return { mode: "skipped", brainDir, staged: 0, gathered: 0 };
  }

  const { candidates, bySource } = await deps.gather(repoRoot);
  deps.log(
    `Found ${candidates.length} candidates — adr:${bySource.adr} git:${bySource.git} config:${bySource.config}`,
  );

  if (candidates.length > 0 && !opts.yes) {
    const ok = await deps.confirm(
      `Seed ${candidates.length} candidates into the brain's review queue?`,
    );
    if (!ok) {
      deps.log(`Skipped seeding. Brain created at ${brainDir}.`);
      return { mode: "skipped", brainDir, staged: 0, gathered: candidates.length };
    }
  }

  const { captured } = candidates.length ? await deps.stage(brainDir, candidates) : { captured: 0 };

  deps.log(
    `Your brain has ${captured} notes pending review. Run \`commonwealth-curate list\` to approve, ` +
      `then start a Claude session here and ask it something your team already knows.`,
  );

  return { mode: "new", brainDir, staged: captured, gathered: candidates.length };
}
