import path from "node:path";
import {
  lintBrain,
  regenerateDerived,
  resolveBrainDir,
  type HygieneFinding,
  type HygieneReport,
  type HygieneSeverity,
} from "@cmnwlth/core";

/**
 * `commonwealth lint` (#258) — the detail view behind `doctor`'s hygiene links. `doctor` answers
 * "is anything wrong?" in one line per dimension; this answers "which note, which field, and what
 * exactly" for every finding, because a dead `superseded_by` is only actionable once you know the
 * file it lives in.
 *
 * Read-only by default. `--fix` regenerates the derived views ONLY (ADR-0003: derived files are
 * rebuilt, never hand-merged), and only ever writes — the derived-file prune sweep is disabled for
 * it, so no file is deleted. Link and metadata findings are canon edits and are deliberately left to
 * a human, since guessing which id a broken chain meant to point at would silently rewrite the
 * team's history.
 *
 * The git/fs surfaces are injected via {@link LintEnv} so tests exercise the orchestration against
 * a fixture brain with no registry lookup.
 */

/** Injectable surfaces (defaults in {@link defaultLintEnv}). */
export interface LintEnv {
  cwd: string;
  /** Resolve the brain for a cwd; null when none maps to it. */
  resolveBrain: (cwd: string) => Promise<string | null>;
  /** Run the hygiene lint over a brain. */
  lint: (brainDir: string, opts: { reportOrphans: boolean }) => Promise<HygieneReport>;
  /** Regenerate the brain's derived views (the `--fix` repair). */
  rebuildDerived: (brainDir: string) => Promise<void>;
}

/** Options parsed from the command line. */
export interface LintOptions {
  /** Rebuild derived views that drifted, then re-lint so the output reports the repaired state. */
  fix?: boolean;
  /** Also list orphan notes (nothing links to them) — informational, never a failure. */
  orphans?: boolean;
}

/** Outcome of a lint run. */
export interface LintRunReport {
  /** Brain that was linted. */
  brain: string;
  report: HygieneReport;
  /** Derived views rebuilt by `--fix` (empty when it wasn't used or nothing had drifted). */
  rebuilt: string[];
  /** True iff no `error`-severity finding remains after any repair. */
  ok: boolean;
}

/** Real surfaces: registry brain resolution (honouring the env pin), core's lint + regenerate. */
export function defaultLintEnv(cwd: string): LintEnv {
  const brainEnv = process.env.COMMONWEALTH_BRAIN_DIR;
  return {
    cwd,
    resolveBrain: (dir) =>
      brainEnv && brainEnv.length > 0
        ? Promise.resolve(path.resolve(brainEnv))
        : resolveBrainDir(dir),
    lint: (brainDir, opts) => lintBrain(brainDir, { reportOrphans: opts.reportOrphans }),
    // `prune: false` — see doctor's `rebuildDerived`: the prune sweep would delete hand-written
    // markdown at a brain/project root, and `--fix` promises to regenerate, never to remove.
    rebuildDerived: (brainDir) => regenerateDerived(brainDir, { prune: false }),
  };
}

/**
 * Lint the brain mapped to `env.cwd`. With `opts.fix`, drifted derived views are regenerated and
 * the brain is re-linted, so the returned report describes the state AFTER the repair (the
 * "`--fix` re-reports clean" contract). Throws when no brain maps to the cwd, and (from
 * `lintBrain`) when the mapped brain directory does not exist.
 */
export async function runLint(opts: LintOptions, env: LintEnv): Promise<LintRunReport> {
  const brain = await env.resolveBrain(env.cwd);
  if (brain === null) {
    throw new Error(
      `No brain is mapped to ${env.cwd}. Run \`commonwealth add ${env.cwd}\` (or \`commonwealth init\`) first.`,
    );
  }

  const reportOrphans = opts.orphans === true;
  let report = await env.lint(brain, { reportOrphans });
  let rebuilt: string[] = [];
  if (opts.fix && report.staleDerived.length > 0) {
    rebuilt = [...report.staleDerived];
    await env.rebuildDerived(brain);
    report = await env.lint(brain, { reportOrphans });
  }
  return { brain, report, rebuilt, ok: report.ok };
}

const SYMBOLS: Record<HygieneSeverity, string> = { error: "✗", warn: "⚠", info: "·" };

/** Group findings by the file they live in, preserving first-seen file order. */
function byFile(findings: HygieneFinding[]): Map<string, HygieneFinding[]> {
  const groups = new Map<string, HygieneFinding[]>();
  for (const f of findings) {
    (groups.get(f.where) ?? groups.set(f.where, []).get(f.where)!).push(f);
  }
  return groups;
}

/** Render a {@link LintRunReport} as grouped, per-file findings with a one-line verdict. */
export function formatLint(run: LintRunReport): string {
  const { report } = run;
  const lines: string[] = [`commonwealth lint — ${run.brain}`, ""];

  if (run.rebuilt.length > 0) {
    lines.push(
      `  regenerated ${run.rebuilt.length} derived view(s): ${run.rebuilt.join(", ")}`,
      "",
    );
  }

  if (report.findings.length === 0) {
    lines.push(
      `  ✓ ${report.noteCount} note(s): links resolve, metadata is intact, derived views match.`,
      "",
    );
    return `${lines.join("\n")}\n`;
  }

  for (const [file, findings] of byFile(report.findings)) {
    lines.push(`  ${file}`);
    for (const f of findings) {
      lines.push(`    ${SYMBOLS[f.severity]} ${f.rule}: ${f.message}`);
    }
  }
  lines.push("");

  const { error, warn, info } = report.counts;
  const parts = [
    `${error} error${error === 1 ? "" : "s"}`,
    `${warn} warning${warn === 1 ? "" : "s"}`,
  ];
  if (info > 0) parts.push(`${info} informational`);
  lines.push(
    `${report.noteCount} note(s) linted — ${parts.join(", ")}.`,
    ...(report.staleDerived.length > 0 && run.rebuilt.length === 0
      ? ["Run `commonwealth lint --fix` to regenerate the drifted derived views."]
      : []),
    ...(error > 0
      ? [
          "Errors are canon edits (a dead supersede id, a note whose id/filename desynced) — fix them by hand; `--fix` only ever regenerates derived views.",
        ]
      : []),
  );
  return `${lines.join("\n")}\n`;
}
