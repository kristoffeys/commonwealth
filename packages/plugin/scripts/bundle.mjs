// Bundle the vendored runtime for the Commonwealth plugin.
//
// The plugin must run standalone on a user's machine with `node` and no pnpm workspace, so
// we copy the built `dist/` of the packages it drives (mcp, curate, sync) plus their FULL
// runtime dependency closure into `packages/plugin/vendor/`. The plugin manifest and hooks
// point at `${CLAUDE_PLUGIN_ROOT}/vendor/<pkg>/index.js`; Node then resolves every bare
// import by walking up to the shared `vendor/node_modules/`.
//
// Dependency resolution follows Node's own algorithm via `createRequire`, so it works with
// pnpm's `.pnpm` virtual store (where most transitive deps live and are NOT hoisted to the
// top-level `node_modules`). We walk the closure from each package's `package.json` rather
// than maintaining a hand-written list — a missing transitive dep (e.g. zod-to-json-schema,
// pulled in by @modelcontextprotocol/sdk) would otherwise crash the server at startup.
//
// NOTE: this is a PLATFORM-LOCAL bundle. `better-sqlite3` ships a prebuilt native binary
// for the OS/arch it was installed on; copying it only works for that same platform. A
// cross-platform build (or npm publish with per-platform prebuilds / on-install rebuild) is
// a LATER task — this script is enough to dogfood and run the smoke test locally and in CI.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const repoRoot = path.resolve(pluginRoot, "..", "..");
const vendorDir = path.join(pluginRoot, "vendor");

/** Packages whose built dist + dependency closure we vendor into the plugin. */
const PACKAGES = ["mcp", "curate", "sync"];

function log(msg) {
  console.error(`[bundle] ${msg}`);
}

/** Build the whole workspace so every package's dist/ is fresh. */
function buildWorkspace() {
  log("building workspace (pnpm -r build)…");
  const res = spawnSync("pnpm", ["-r", "build"], { cwd: repoRoot, stdio: "inherit" });
  if (res.status !== 0) {
    throw new Error(`pnpm -r build failed with code ${res.status}`);
  }
}

/**
 * Resolve the on-disk directory of `dep` as required from `fromDir`, following pnpm's
 * symlinked layout. Returns null if it cannot be resolved (logged, best-effort).
 */
/** Walk up from `startDir` to the package ROOT whose package.json `name` === `dep`. */
function findPackageRoot(startDir, dep) {
  let d = startDir;
  for (;;) {
    const pjPath = path.join(d, "package.json");
    if (existsSync(pjPath)) {
      try {
        if (JSON.parse(readFileSync(pjPath, "utf8")).name === dep) return d;
      } catch {
        // corrupt/stub package.json — keep walking up
      }
    }
    const parent = path.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

function resolvePkgDir(fromDir, dep) {
  // Workspace packages (@cmnwlth/*) live at packages/<name>; pnpm symlinks them and
  // their "exports" can block createRequire, so resolve them directly.
  if (dep.startsWith("@cmnwlth/")) {
    const wsDir = path.join(repoRoot, "packages", dep.slice("@cmnwlth/".length));
    return existsSync(path.join(wsDir, "package.json")) ? wsDir : null;
  }
  const req = createRequire(path.join(fromDir, "package.json"));
  // Both `dep/package.json` and the main entry can resolve to a NESTED stub package.json
  // (e.g. dist/cjs/{"type":"commonjs"}) when a package uses "exports". Get any anchor inside
  // the package, then walk up to the real root (the package.json whose `name` === dep).
  let anchor = null;
  try {
    anchor = path.dirname(req.resolve(`${dep}/package.json`));
  } catch {
    // fall through to the entry resolve
  }
  if (!anchor) {
    try {
      anchor = path.dirname(req.resolve(dep));
    } catch {
      return null;
    }
  }
  return findPackageRoot(anchor, dep);
}

/**
 * Walk the runtime dependency closure. `collected` maps dep name → source dir. Resolution is
 * anchored at each package's own directory so pnpm's nested versions resolve correctly.
 */
function collectClosure(fromDir, depNames, collected) {
  for (const dep of depNames) {
    if (collected.has(dep)) continue;
    const dir = resolvePkgDir(fromDir, dep);
    if (!dir) {
      log(`  (skip) unresolved dependency: ${dep} (from ${path.relative(repoRoot, fromDir)})`);
      continue;
    }
    collected.set(dep, dir);
    let pj;
    try {
      pj = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    const next = Object.keys(pj.dependencies ?? {});
    if (next.length) collectClosure(dir, next, collected);
  }
}

/** Copy one resolved package dir into `vendor/node_modules/<dep>`, minus nested node_modules. */
function vendorDep(dep, src) {
  const dest = path.join(vendorDir, "node_modules", dep);
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest, {
    recursive: true,
    dereference: true,
    // Deps are flattened into the shared vendor/node_modules, so never descend into a
    // package's own node_modules (avoids symlink cycles and huge duplicate trees).
    filter: (s) => path.basename(s) !== "node_modules",
  });
}

function main() {
  buildWorkspace();
  log("clearing vendor/…");
  rmSync(vendorDir, { recursive: true, force: true });
  mkdirSync(vendorDir, { recursive: true });

  // 1) Collect the full runtime closure of all vendored packages into one map.
  const collected = new Map();
  for (const pkg of PACKAGES) {
    const pkgDir = path.join(repoRoot, "packages", pkg);
    const pj = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    collectClosure(pkgDir, Object.keys(pj.dependencies ?? {}), collected);
  }
  log(`resolved ${collected.size} runtime dependencies`);

  // 2) Copy the closure into the shared vendor/node_modules/.
  for (const [dep, src] of collected) vendorDep(dep, src);

  // 3) Copy each package's built dist to vendor/<pkg>/ (entry = vendor/<pkg>/index.js).
  for (const pkg of PACKAGES) {
    const distSrc = path.join(repoRoot, "packages", pkg, "dist");
    if (!existsSync(distSrc)) {
      throw new Error(`missing dist for ${pkg}; did the build succeed?`);
    }
    log(`vendoring ${pkg} → ${path.relative(pluginRoot, path.join(vendorDir, pkg))}`);
    cpSync(distSrc, path.join(vendorDir, pkg), { recursive: true });
  }

  log("done. Vendored: " + PACKAGES.join(", "));
  log("Reminder: this bundle is platform-local (better-sqlite3 prebuilt binary).");
}

main();
