#!/usr/bin/env node
// Release helper: bump the version across EVERY version-bearing file in the monorepo in
// lockstep, then (optionally) commit + tag it. Complements Changesets, which bumps the
// publishable package.json versions but does NOT touch the plugin's pinned runtime
// (`@cmnwlth/mcp@X` / `@cmnwlth/curate@X`), plugin.json, or the marketplace listing — so those
// silently drift (they sat at 0.1.0 while the packages were 0.1.2). This keeps them together.
//
// Usage:
//   node scripts/release.mjs <patch|minor|major|X.Y.Z> [--commit] [--dry-run]
//   node scripts/release.mjs sync [--dry-run]     # align plugin pins to the CURRENT version
//
// `--commit` stages the changed files, commits `chore(release): vX.Y.Z`, and creates an
// annotated `vX.Y.Z` tag (which the Release workflow publishes on push). Without it, files are
// edited and left for you to review/commit. `--dry-run` prints the plan and writes nothing.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The workspace packages whose package.json `version` moves in lockstep. */
const PACKAGES = ["cli", "core", "curate", "mcp", "plugin", "seed", "sync"];

/**
 * Every file that carries the release version, and how to rewrite it. Each entry replaces the
 * FIRST match of `pattern` with the same text but the new version — a targeted edit that keeps
 * each file's existing formatting (no JSON reserialization, so no incidental churn).
 */
function versionTargets() {
  const targets = [];
  for (const pkg of PACKAGES) {
    targets.push({
      file: path.join(ROOT, "packages", pkg, "package.json"),
      // The package's own top-level "version" — the first "version": "..." in the file.
      pattern: /"version":\s*"[^"]*"/,
      make: (v) => `"version": "${v}"`,
    });
  }
  return [
    ...targets,
    {
      file: path.join(ROOT, "packages", "plugin", ".claude-plugin", "plugin.json"),
      pattern: /"version":\s*"[^"]*"/,
      make: (v) => `"version": "${v}"`,
    },
    {
      file: path.join(ROOT, ".claude-plugin", "marketplace.json"),
      pattern: /"version":\s*"[^"]*"/,
      make: (v) => `"version": "${v}"`,
    },
    {
      // Runtime pin the installed plugin runs via npx — must match a published package version.
      file: path.join(ROOT, "packages", "plugin", ".mcp.json"),
      pattern: /@cmnwlth\/mcp@[0-9]+\.[0-9]+\.[0-9]+/,
      make: (v) => `@cmnwlth/mcp@${v}`,
    },
    {
      // Same, for the hooks' curate runtime default.
      file: path.join(ROOT, "packages", "plugin", "hooks", "lib.mjs"),
      pattern: /@cmnwlth\/curate@[0-9]+\.[0-9]+\.[0-9]+/,
      make: (v) => `@cmnwlth/curate@${v}`,
    },
  ];
}

/** Parse `X.Y.Z` (ignoring any `-prerelease`/`+build`) into `[major, minor, patch]` numbers. */
function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) throw new Error(`not a semver version: "${v}"`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Resolve the next version from `current` and a `bump` argument: a `patch`/`minor`/`major`
 * keyword bumps `current`; an explicit `X.Y.Z` is validated and used as-is (must be > current).
 * Exported for tests.
 */
export function nextVersion(current, bump) {
  const [major, minor, patch] = parseSemver(current);
  switch (bump) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default: {
      // Explicit version: validate shape and require a forward move (guards typos/downgrades).
      const [nMaj, nMin, nPat] = parseSemver(bump);
      const asNum = (a, b, c) => a * 1e6 + b * 1e3 + c;
      if (asNum(nMaj, nMin, nPat) <= asNum(major, minor, patch)) {
        throw new Error(`refusing to set version ${bump} — not greater than current ${current}`);
      }
      return `${nMaj}.${nMin}.${nPat}`;
    }
  }
}

/** Read the canonical current version (packages/core, the head of the fixed version group). */
export function currentVersion() {
  const corePkg = JSON.parse(
    readFileSync(path.join(ROOT, "packages", "core", "package.json"), "utf8"),
  );
  return corePkg.version;
}

/**
 * Rewrite every {@link versionTargets} file to `version`. Returns the list of files changed
 * (a file whose match already equals the target is skipped). When `dryRun`, writes nothing.
 */
export function applyVersion(version, { dryRun = false } = {}) {
  const changed = [];
  for (const target of versionTargets()) {
    const before = readFileSync(target.file, "utf8");
    const replacement = target.make(version);
    if (!target.pattern.test(before)) {
      throw new Error(`no version match in ${path.relative(ROOT, target.file)} (pattern drift?)`);
    }
    const after = before.replace(target.pattern, replacement);
    if (after !== before) {
      changed.push(target.file);
      if (!dryRun) writeFileSync(target.file, after);
    }
  }
  return changed;
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] })
    .toString()
    .trim();
}

function main() {
  const args = process.argv.slice(2);
  const bump = args[0];
  const dryRun = args.includes("--dry-run");
  const doCommit = args.includes("--commit");

  if (!bump || bump.startsWith("--")) {
    console.error(
      "usage: node scripts/release.mjs <patch|minor|major|X.Y.Z> [--commit] [--dry-run]\n" +
        "       node scripts/release.mjs sync [--dry-run]",
    );
    process.exit(1);
  }

  const current = currentVersion();
  // `sync` re-aligns the plugin pins to the current version without bumping (fixes drift).
  const version = bump === "sync" ? current : nextVersion(current, bump);

  console.error(`current: ${current}`);
  console.error(`${bump === "sync" ? "syncing to" : "target"}: ${version}`);

  const changed = applyVersion(version, { dryRun });
  for (const f of changed)
    console.error(`  ${dryRun ? "would update" : "updated"} ${path.relative(ROOT, f)}`);
  if (changed.length === 0) console.error("  (already at target — nothing to change)");

  if (dryRun) return;

  if (doCommit && bump !== "sync") {
    if (changed.length === 0) {
      console.error("nothing changed; not committing.");
      return;
    }
    git(["add", ...changed]);
    git(["commit", "-m", `chore(release): v${version}`]);
    git(["tag", "-a", `v${version}`, "-m", `Release v${version}`]);
    console.error(`\nCommitted and tagged v${version}.`);
    console.error(
      `Next: git push --follow-tags   (the Release workflow publishes to npm and creates ` +
        `the GitHub Release with generated notes)`,
    );
  } else if (!doCommit) {
    console.error(`\nFiles updated. Review, then commit + tag (or re-run with --commit).`);
  }

  // Emit the resolved version on stdout so CI can capture it (`VERSION=$(node scripts/release.mjs …)`).
  console.log(version);
}

// Run only as a CLI, not when imported by tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
