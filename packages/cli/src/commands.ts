import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { FEATURE_FLAGS, loadBrainConfig, resolveBrainDir, setFeature } from "@cmnwlth/core";
import { gatherCandidates } from "@cmnwlth/seed";
import { findGitRepos } from "./discover.js";

/**
 * The unified `commonwealth <verb>` subcommands beyond `init` (#93). Every command resolves the
 * brain the same way the MCP server and hooks do — via the registry against the cwd — so the
 * user never passes `--dir` or reruns `init` to act on their brain. Verbs with battle-tested
 * logic in the curate/sync binaries delegate to them (registry-aware since #69, so inheriting
 * the cwd is enough); `reseed` and `config` compose core + seed directly.
 */

const require = createRequire(import.meta.url);

/** Resolve a workspace package's built bin entry (e.g. `@cmnwlth/curate`). */
function resolvePkgBin(pkg: string): string {
  const pkgJsonPath = require.resolve(`${pkg}/package.json`);
  const pkgJson = require(`${pkg}/package.json`) as { bin?: string | Record<string, string> };
  const rel = typeof pkgJson.bin === "string" ? pkgJson.bin : Object.values(pkgJson.bin ?? {})[0];
  if (!rel) throw new Error(`${pkg} exposes no bin`);
  return path.join(path.dirname(pkgJsonPath), rel);
}

/** Spawn `node <bin> <args>` with inherited stdio; resolves to the child's exit code. */
function runBin(bin: string, args: string[], input?: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("node", [bin, ...args], {
      stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
    });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 0));
    if (input !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.write(input, () => child.stdin!.end());
    }
  });
}

/** Resolve the brain for the cwd, or print an actionable error and return null. */
async function brainOrError(): Promise<string | null> {
  const env = process.env.COMMONWEALTH_BRAIN_DIR;
  const brain = env && env.length > 0 ? path.resolve(env) : await resolveBrainDir(process.cwd());
  if (!brain) {
    process.stderr.write(
      `No Commonwealth brain is configured for ${process.cwd()}. Run \`commonwealth init\` here, ` +
        `or add a prefix → brain mapping to ~/.commonwealth/registry.json.\n`,
    );
    return null;
  }
  return brain;
}

/** `commonwealth config <list | get <key> | set <key> <value>>` — the brain's shared config. */
export async function cmdConfig(rest: string[]): Promise<number> {
  const brain = await brainOrError();
  if (!brain) return 1;
  const [sub, key, value] = rest;
  const config = await loadBrainConfig(brain);
  const flagNames = FEATURE_FLAGS.map((f) => f.name);

  if (sub === undefined || sub === "list") {
    process.stdout.write(
      `brain: ${brain}\nname: ${config.name}\n` +
        `remotes: ${config.remotes.join(", ") || "(none)"}\nfeatures:\n`,
    );
    for (const flag of FEATURE_FLAGS) {
      const val = config.features[flag.name] ?? flag.default;
      process.stdout.write(`  ${flag.name} = ${val}  — ${flag.description}\n`);
    }
    return 0;
  }
  if (sub === "get") {
    if (!key) {
      process.stderr.write("usage: commonwealth config get <key>\n");
      return 2;
    }
    if (key === "name") process.stdout.write(`${config.name}\n`);
    else if (flagNames.includes(key)) process.stdout.write(`${config.features[key] ?? false}\n`);
    else {
      process.stderr.write(`Unknown config key "${key}". Known: name, ${flagNames.join(", ")}\n`);
      return 2;
    }
    return 0;
  }
  if (sub === "set") {
    if (!key || value === undefined) {
      process.stderr.write("usage: commonwealth config set <key> <value>\n");
      return 2;
    }
    if (!flagNames.includes(key)) {
      process.stderr.write(`Unknown feature flag "${key}". Known: ${flagNames.join(", ")}\n`);
      return 2;
    }
    const on = value === "true" || value === "1" || value === "on" || value === "yes";
    await setFeature(brain, key, on);
    process.stderr.write(`[commonwealth] set ${key} = ${on} for ${brain}\n`);
    return 0;
  }
  process.stderr.write("usage: commonwealth config <list | get <key> | set <key> <value>>\n");
  return 2;
}

/**
 * `commonwealth reseed [<repo>...] [--all]` — mine repo(s) into the MAPPED brain and capture.
 * Defaults to the current repo; `<repo>...` names explicit dirs; `--all` mines every git repo
 * found under the cwd. Notes file under `<project>/<kind>/` (source per repo, ADR-0015) and
 * land per the brain's `autoPromote` — set it false first (`commonwealth config set autoPromote
 * false`) to review before canon.
 */
export async function cmdReseed(rest: string[]): Promise<number> {
  const brain = await brainOrError();
  if (!brain) return 1;
  const all = rest.includes("--all");
  const explicit = rest.filter((a) => !a.startsWith("-")).map((a) => path.resolve(a));

  const repos =
    explicit.length > 0
      ? explicit
      : all
        ? await findGitRepos(process.cwd())
        : [path.resolve(process.cwd())];
  if (repos.length === 0) {
    process.stderr.write("No repositories to reseed.\n");
    return 0;
  }

  const curateBin = resolvePkgBin("@cmnwlth/curate");
  let total = 0;
  for (const repo of repos) {
    const { candidates } = await gatherCandidates(repo);
    if (candidates.length === 0) {
      process.stderr.write(`[commonwealth] ${repo}: no candidates.\n`);
      continue;
    }
    process.stderr.write(`[commonwealth] ${repo}: mined ${candidates.length} candidate(s)…\n`);
    // Delegate to curate capture (registry-aware; applies scope+dedup+secret gates + autoPromote).
    // --force bypasses the per-session scope gate: reseed is a deliberate import, not a session.
    const code = await runBin(
      curateBin,
      ["capture", "--dir", brain, "--cwd", repo, "--force"],
      JSON.stringify(candidates),
    );
    if (code === 0) total += candidates.length;
  }
  process.stderr.write(
    `[commonwealth] reseed done: ${total} candidate(s) captured into ${brain}.\n`,
  );
  return 0;
}

/** Delegate a verb to the registry-aware curate binary, inheriting the cwd + stdio. */
export function delegateCurate(args: string[]): Promise<number> {
  return runBin(resolvePkgBin("@cmnwlth/curate"), args);
}

/** Delegate a verb to the registry-aware sync binary, inheriting the cwd + stdio. */
export function delegateSync(args: string[]): Promise<number> {
  return runBin(resolvePkgBin("@cmnwlth/sync"), args);
}
