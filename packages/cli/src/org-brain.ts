import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "@cmnwlth/core";

/**
 * `commonwealth org-brain` (#167, ADR-0023) — designate and inspect the org-brain: the shared brain
 * that cross-brain knowledge graduates *up* to (#110). Designation is a local per-machine pointer
 * in the user registry (locating the org-brain must not require scanning every wired brain's
 * config); a `--remote` records where to clone it from on demand (ADR-0019), so the pointer can be
 * set before the brain exists locally.
 *
 *   commonwealth org-brain set <dir> [--remote <url>]
 *   commonwealth org-brain show
 */

/** Parsed `commonwealth org-brain` invocation. */
export interface OrgBrainOptions {
  /** Sub-action: designate the org-brain, or print the current pointer. */
  action: "set" | "show";
  /** Target brain directory (`set` only). */
  dir?: string;
  /** Git remote to clone the org-brain from on demand (`set --remote`). */
  remote?: string;
}

/** Injected effects of {@link runOrgBrain}; wired for real in {@link defaultOrgBrainDeps}. */
export interface OrgBrainDeps {
  /** True when `p` exists and is a directory. */
  isDir(p: string): Promise<boolean>;
  /** True when `dir` is a brain (has the `.commonwealth/schema-version` scaffold artifact). */
  isBrain(dir: string): Promise<boolean>;
  /** Persist the org-brain pointer (atomic, refuse-to-clobber-corrupt). */
  setOrgBrain(brain: string, remote?: string): Promise<void>;
  /** Read the current org-brain pointer, or null when none is designated. */
  getOrgBrain(): Promise<core.ResolvedBrain | null>;
  /** Progress/diagnostic sink (stderr in production). */
  log(m: string): void;
  /** Result sink (stdout in production). */
  out(m: string): void;
}

/** Expand a leading `~` to the home directory, then resolve to an absolute path. */
function expand(entry: string): string {
  const home = os.homedir();
  if (entry === "~") return path.resolve(home);
  if (entry.startsWith("~/")) return path.resolve(home, entry.slice(2));
  return path.resolve(entry);
}

/** Parse `commonwealth org-brain` argv into {@link OrgBrainOptions}, or null on a usage error. */
export function parseOrgBrainArgs(rest: string[]): OrgBrainOptions | null {
  const action = rest[0];
  if (action === "show") return { action: "show" };
  if (action !== "set") return null;
  let dir: string | undefined;
  let remote: string | undefined;
  for (let i = 1; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (arg === "--remote") {
      remote = rest[i + 1];
      if (remote === undefined || remote.length === 0) return null; // dangling flag
      i += 1;
    } else if (arg.startsWith("--")) {
      return null;
    } else if (dir === undefined) {
      dir = arg;
    } else {
      return null; // more than one positional
    }
  }
  if (dir === undefined) return null;
  return { action: "set", dir, ...(remote ? { remote } : {}) };
}

/**
 * Designate or show the org-brain. Pure orchestration over {@link OrgBrainDeps}.
 *
 * `set` records `dir` as the org-brain. The target must be a real brain UNLESS `--remote` is given,
 * in which case a not-yet-cloned pointer is allowed (clone-on-demand materializes it later). `show`
 * prints the current pointer.
 *
 * @returns Exit code: 0 on success, 1 on a write failure, 2 on a usage/validation error.
 */
export async function runOrgBrain(opts: OrgBrainOptions, deps: OrgBrainDeps): Promise<number> {
  if (opts.action === "show") {
    const org = await deps.getOrgBrain();
    if (org === null) {
      deps.out("org-brain: none designated (set one with `commonwealth org-brain set <dir>`)");
      return 0;
    }
    deps.out(`org-brain: ${org.brain}${org.remote ? ` (remote ${org.remote})` : ""}`);
    return 0;
  }

  const dir = expand(opts.dir as string);
  const exists = await deps.isDir(dir);
  if (exists) {
    if (!(await deps.isBrain(dir))) {
      deps.log(
        `org-brain: ${dir} is not a brain (no .commonwealth/schema-version) — ` +
          `create it first with \`commonwealth init --brain ${dir}\`.`,
      );
      return 2;
    }
  } else if (opts.remote === undefined) {
    // Nothing to point at: no local brain and no remote to clone from later.
    deps.log(
      `org-brain: ${dir} does not exist — create it with \`commonwealth init --brain ${dir}\` ` +
        `or pass --remote <url> to record a clone-on-demand pointer.`,
    );
    return 2;
  }

  try {
    await deps.setOrgBrain(dir, opts.remote);
  } catch (err) {
    deps.log(`org-brain: FAILED to designate ${dir}: ${(err as Error).message}`);
    return 1;
  }
  deps.log(
    `org-brain: designated ${dir}${opts.remote ? ` (remote ${opts.remote})` : ""}` +
      (exists ? "" : " — not cloned yet; will clone on demand"),
  );
  return 0;
}

/** The real {@link OrgBrainDeps}: core registry IO, stderr diagnostics, stdout results. */
export function defaultOrgBrainDeps(): OrgBrainDeps {
  return {
    isDir: async (p) => {
      try {
        return (await fs.stat(p)).isDirectory();
      } catch {
        return false;
      }
    },
    isBrain: async (dir) => {
      try {
        return (await fs.stat(path.join(dir, ".commonwealth", "schema-version"))).isFile();
      } catch {
        return false;
      }
    },
    setOrgBrain: (brain, remote) => core.setOrgBrain(brain, remote ? { remote } : {}),
    getOrgBrain: () => core.getOrgBrain(),
    log: (m) => {
      process.stderr.write(`${m}\n`);
    },
    out: (m) => {
      process.stdout.write(`${m}\n`);
    },
  };
}

/** Entry point wired into the CLI dispatch: parse argv, then run. */
export async function cmdOrgBrain(rest: string[]): Promise<number> {
  const opts = parseOrgBrainArgs(rest);
  if (opts === null) {
    process.stderr.write(
      "usage: commonwealth org-brain set <dir> [--remote <url>]\n" +
        "       commonwealth org-brain show\n",
    );
    return 2;
  }
  return runOrgBrain(opts, defaultOrgBrainDeps());
}
