import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBrainDir, verifyBrain, type VerifyResult } from "@cmnwlth/core";

/**
 * `commonwealth verify-restore` (#136) — the CI-runnable disaster-recovery proof. It clones the
 * brain (from its remote for the real off-site proof, or from the local repo to prove the
 * committed state) into a throwaway temp dir and runs {@link verifyBrain} there, then prints an
 * RPO line (how far back the last commit is — your worst-case data loss window). Read-only w.r.t.
 * the user's brain: it only ever writes inside the temp clone, which it deletes.
 *
 * The git/filesystem surfaces are injected via {@link VerifyRestoreEnv} so tests exercise the
 * orchestration with a fake clone and no network.
 */

/** Injectable git + filesystem surfaces (defaults in {@link defaultVerifyRestoreEnv}). */
export interface VerifyRestoreEnv {
  cwd: string;
  /** Resolve the brain for a cwd. */
  resolveBrain: (cwd: string) => Promise<string | null>;
  /** The brain's `origin` remote URL, or null when it has none. */
  originUrl: (brainDir: string) => string | null;
  /** Clone `source` into `dest`; resolves true on success. */
  clone: (source: string, dest: string) => Promise<boolean>;
  /** ISO-8601 committer date of the clone's HEAD, or null (no commits / not a repo). */
  lastCommitISO: (dir: string) => string | null;
  /** Make a fresh temp directory to clone into. */
  mkTemp: () => Promise<string>;
  /** Remove a temp directory (best-effort). */
  cleanup: (dir: string) => Promise<void>;
  /** Current time (injectable for deterministic RPO tests). */
  now: () => Date;
}

/** Outcome of a verify-restore run. */
export interface VerifyRestoreReport {
  /** What was cloned: a remote URL (`--from-remote`) or the local brain path. */
  source: string;
  fromRemote: boolean;
  /** Whether the clone itself succeeded. */
  cloned: boolean;
  /** ISO timestamp of the recovered HEAD, or null. */
  lastCommit: string | null;
  /** Human recovery-point objective, e.g. "2h 5m" — the age of `lastCommit`. */
  rpo: string | null;
  /** The recovery proof, or null when the clone failed. */
  result: VerifyResult | null;
  /** True iff the clone succeeded and every verification check passed. */
  ok: boolean;
}

/** Real git + fs surfaces. */
export function defaultVerifyRestoreEnv(cwd: string): VerifyRestoreEnv {
  const git = (dir: string, args: string[]): { code: number; out: string } => {
    const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    return { code: r.status ?? 1, out: (r.stdout ?? "").trim() };
  };
  const brainEnv = process.env.COMMONWEALTH_BRAIN_DIR;
  return {
    cwd,
    resolveBrain: (dir) =>
      brainEnv && brainEnv.length > 0
        ? Promise.resolve(path.resolve(brainEnv))
        : resolveBrainDir(dir),
    originUrl: (brainDir) => {
      const r = git(brainDir, ["remote", "get-url", "origin"]);
      return r.code === 0 && r.out.length > 0 ? r.out : null;
    },
    clone: (source, dest) =>
      new Promise<boolean>((resolve) => {
        const r = spawnSync("git", ["clone", "--quiet", source, dest], { stdio: "ignore" });
        resolve(!r.error && r.status === 0);
      }),
    lastCommitISO: (dir) => {
      const r = git(dir, ["log", "-1", "--format=%cI"]);
      return r.code === 0 && r.out.length > 0 ? r.out : null;
    },
    mkTemp: () => fs.mkdtemp(path.join(os.tmpdir(), "cw-verify-")),
    cleanup: (dir) => fs.rm(dir, { recursive: true, force: true }),
    now: () => new Date(),
  };
}

/** Format a millisecond duration as a compact `1d 3h`, `2h 5m`, or `45s` string. */
function humanizeAge(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/**
 * Clone the brain into a temp dir and run the recovery proof. `fromRemote` clones the `origin`
 * remote (the true off-site proof); otherwise it clones the local brain repo (proving the
 * committed state restores, ignoring uncommitted working-tree edits). Always cleans up the clone.
 */
export async function runVerifyRestore(
  opts: { fromRemote?: boolean },
  env: VerifyRestoreEnv,
): Promise<VerifyRestoreReport> {
  const fromRemote = opts.fromRemote ?? false;
  const brain = await env.resolveBrain(path.resolve(env.cwd));
  if (!brain) {
    throw new Error(
      `No Commonwealth brain resolves for ${env.cwd}. Run \`commonwealth init\` or add a registry mapping.`,
    );
  }
  const source = fromRemote ? env.originUrl(brain) : brain;
  if (fromRemote && !source) {
    throw new Error(
      `Brain at ${brain} has no \`origin\` remote to restore from. Add one with \`commonwealth init --remote <url>\`.`,
    );
  }

  const temp = await env.mkTemp();
  try {
    const cloned = await env.clone(source!, temp);
    if (!cloned) {
      return {
        source: source!,
        fromRemote,
        cloned: false,
        lastCommit: null,
        rpo: null,
        result: null,
        ok: false,
      };
    }
    const lastCommit = env.lastCommitISO(temp);
    const rpo =
      lastCommit === null
        ? null
        : humanizeAge(env.now().getTime() - new Date(lastCommit).getTime());
    const result = await verifyBrain(temp);
    return { source: source!, fromRemote, cloned: true, lastCommit, rpo, result, ok: result.ok };
  } finally {
    await env.cleanup(temp);
  }
}

/** Render a {@link VerifyRestoreReport} as the human pass/fail proof with an RPO line. */
export function formatVerifyRestore(report: VerifyRestoreReport): string {
  const lines: string[] = [
    `commonwealth verify-restore — ${report.fromRemote ? "from remote" : "from committed state"}`,
    `  source: ${report.source}`,
  ];
  if (!report.cloned) {
    lines.push("", "  ✗ Clone failed — could not restore the brain from its source.", "");
    lines.push("Restore FAILED.");
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    `  RPO: ${report.lastCommit ?? "unknown"}${report.rpo ? ` (${report.rpo} ago)` : ""}`,
    "",
  );
  for (const c of report.result!.checks) {
    lines.push(`  ${c.ok ? "✓" : "✗"} ${c.label.padEnd(16)} ${c.detail}`);
    if (!c.ok && c.offenders) {
      for (const o of c.offenders.slice(0, 10)) lines.push(`      - ${o}`);
      if (c.offenders.length > 10) lines.push(`      … and ${c.offenders.length - 10} more`);
    }
  }
  lines.push("");
  lines.push(
    report.ok
      ? `Restore verified — ${report.result!.noteCount} note(s) recovered, all checks pass.`
      : `Restore FAILED — ${report.result!.checks.filter((c) => !c.ok).length} check(s) failed.`,
  );
  return `${lines.join("\n")}\n`;
}
