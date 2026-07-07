import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "@cmnwlth/core";
import { addAllow } from "@cmnwlth/curate";

/**
 * `commonwealth add` (#157) — the lightweight day-2 counterpart to `init --sync`: wire one or
 * more folders to an EXISTING brain in one go. Per folder it (a) adds the folder to the per-user
 * capture allowlist (ADR-0008), (b) writes a `prefix → brain` mapping to the global registry
 * (ADR-0011), and (c) drops the `~/.commonwealth/brains/<name>` convenience symlink. Without
 * this command the allowlist and registry are only ever written together by full `init`
 * onboarding, and a `scope allow` alone leaves a folder allowed-but-unmapped — capture is
 * permitted there but resolves no brain, so it silently does nothing.
 */

/** Options for {@link runAdd}, parsed from `commonwealth add` argv. */
export interface AddOptions {
  /** Folders to wire to the brain; empty means "the invocation dir". */
  folders: string[];
  /** Explicit brain directory (`--brain`); default: the brain the invocation dir resolves to. */
  brain?: string;
  /**
   * Git remote to record on each mapping (`--remote`, ADR-0019 clone-on-demand); default: the
   * remote carried by the invocation dir's existing mapping, when the brain came from one.
   */
  remote?: string;
  /** Invocation directory: the default folder target AND where the default brain resolves from. */
  cwd: string;
}

/** The injected effects of {@link runAdd}; wired for real in {@link defaultAddDeps}. */
export interface AddDeps {
  /** Resolve the brain (and its mapping's remote) for a directory, or null when none. */
  resolveBrain(cwd: string): Promise<core.ResolvedBrain | null>;
  /** True when `p` exists and is a directory. */
  isDir(p: string): Promise<boolean>;
  /** True when `dir` is a brain (has the `.commonwealth/schema-version` scaffold artifact). */
  isBrain(dir: string): Promise<boolean>;
  /** Idempotently add `folder` to the per-user capture allowlist (`scope allow`). */
  allow(folder: string): Promise<void>;
  /**
   * Write the registry mapping + brains/ symlink for `folder → brainDir`. `mapFailed` reports a
   * failed mapping write (the fatal case); `linkSkipped` a merely-skipped convenience symlink.
   */
  registerBrain(
    folder: string,
    brainDir: string,
    remote?: string,
  ): Promise<{
    added: boolean;
    updated: boolean;
    linked: boolean;
    mapFailed?: string;
    linkSkipped?: string;
  }>;
  /** Progress/diagnostic sink (stderr in production). */
  log(m: string): void;
}

/** Expand a leading `~` to the home directory, then resolve to an absolute path. */
function expand(entry: string): string {
  const home = os.homedir();
  if (entry === "~") return path.resolve(home);
  if (entry.startsWith("~/")) return path.resolve(home, entry.slice(2));
  return path.resolve(entry);
}

/**
 * Wire folders to a brain: allowlist + registry mapping + symlink per folder. Pure
 * orchestration over {@link AddDeps}; never throws for expected failure modes.
 *
 * @returns Exit code: 0 all folders wired, 1 some mapping step failed, 2 usage/resolution error.
 */
export async function runAdd(opts: AddOptions, deps: AddDeps): Promise<number> {
  const folders = (opts.folders.length > 0 ? opts.folders : [opts.cwd]).map(expand);

  // Validate every folder up front, so a typo wires nothing rather than half the list.
  const missing: string[] = [];
  for (const folder of folders) {
    if (!(await deps.isDir(folder))) missing.push(folder);
  }
  if (missing.length > 0) {
    deps.log(`add: not a directory: ${missing.join(", ")}`);
    return 2;
  }

  // Resolve the target brain: --brain wins; else the invocation dir's own mapping.
  let brainDir: string;
  let mappedRemote: string | undefined;
  if (opts.brain !== undefined) {
    brainDir = expand(opts.brain);
  } else {
    const resolved = await deps.resolveBrain(opts.cwd);
    if (resolved === null) {
      deps.log(
        `add: no brain resolves for ${opts.cwd} — pass --brain <dir> ` +
          `(see ~/.commonwealth/brains/) or create one with \`commonwealth init\`.`,
      );
      return 2;
    }
    brainDir = resolved.brain;
    mappedRemote = resolved.remote;
  }

  if (!(await deps.isBrain(brainDir))) {
    deps.log(
      `add: ${brainDir} is not a brain (no .commonwealth/schema-version) — ` +
        `create it first with \`commonwealth init --brain ${brainDir}\`.`,
    );
    return 2;
  }

  const remote = opts.remote ?? mappedRemote;
  let failures = 0;
  for (const folder of folders) {
    await deps.allow(folder);
    const reg = await deps.registerBrain(folder, brainDir, remote);
    if (reg.mapFailed !== undefined) {
      failures += 1;
      deps.log(`add: FAILED to map ${folder}: ${reg.mapFailed}`);
      continue;
    }
    // An update means the folder was already mapped elsewhere and is now redirected — say so
    // explicitly (never silently overwrite wiring state).
    const verb = reg.updated ? "remapped" : reg.added ? "mapped" : "already mapped";
    deps.log(`add: ${verb} ${folder} -> ${brainDir} (allowlisted)`);
    if (reg.linkSkipped) deps.log(`add: symlink skipped for ${brainDir}: ${reg.linkSkipped}`);
  }

  deps.log(
    `add: ${folders.length - failures}/${folders.length} folder(s) wired to ${brainDir}` +
      (remote ? ` (remote ${remote})` : ""),
  );
  return failures > 0 ? 1 : 0;
}

/** The real {@link AddDeps}: core registry/symlink IO, curate's allowlist, stderr logging. */
export function defaultAddDeps(): AddDeps {
  return {
    resolveBrain: (cwd) => core.resolveBrainMapping(cwd),
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
    allow: async (folder) => {
      await addAllow(folder);
    },
    registerBrain: async (folder, brainDir, remote) => {
      try {
        const map = await core.wireFolder(folder, brainDir, { remote });
        const link = await core.linkBrain(path.basename(brainDir), brainDir);
        return {
          added: map.added,
          updated: map.updated,
          linked: link.linked,
          ...(link.skipped !== undefined ? { linkSkipped: link.skipped } : {}),
        };
      } catch (err) {
        return { added: false, updated: false, linked: false, mapFailed: (err as Error).message };
      }
    },
    log: (m) => {
      process.stderr.write(`${m}\n`);
    },
  };
}
