// Bundle the vendored runtime for the Commons plugin.
//
// The plugin must run standalone on a user's machine with `node` and no pnpm workspace, so
// we copy the built `dist/` of the packages it drives (mcp, curate, sync) plus their
// required runtime node_modules into `packages/plugin/vendor/<pkg>/`. The plugin manifest
// and hooks then point at `${CLAUDE_PLUGIN_ROOT}/vendor/<pkg>/index.js`.
//
// NOTE: this is a PLATFORM-LOCAL bundle. `better-sqlite3` ships a prebuilt native binary
// for the OS/arch it was installed on; copying it only works for that same platform. A
// cross-platform build (or npm publish with per-platform prebuilds / on-install rebuild) is
// a LATER task — this script is enough to dogfood and run the manual smoke test locally.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const repoRoot = path.resolve(pluginRoot, "..", "..");
const vendorDir = path.join(pluginRoot, "vendor");

/** Packages whose built dist + deps we vendor into the plugin. */
const PACKAGES = ["mcp", "curate", "sync"];

/** Runtime node_modules to copy alongside each package (transitive, best-effort). */
const RUNTIME_DEPS = [
  "@commons/core",
  "better-sqlite3",
  "bindings",
  "file-uri-to-path",
  "@modelcontextprotocol/sdk",
  "zod",
  "gray-matter",
  "github-slugger",
  "nanoid",
  "chokidar",
  "simple-git",
];

function log(msg) {
  console.error(`[bundle] ${msg}`);
}

/** Build the whole workspace so every package's dist/ is fresh. */
function buildWorkspace() {
  log("building workspace (pnpm -r build)…");
  const res = spawnSync("pnpm", ["-r", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (res.status !== 0) {
    throw new Error(`pnpm -r build failed with code ${res.status}`);
  }
}

/** Copy a node_modules dependency into the destination if it exists (best-effort). */
function copyDep(destModules, depName) {
  // Resolve from the repo root's node_modules (pnpm hoists), then the package's own.
  const candidates = [
    path.join(repoRoot, "node_modules", depName),
    ...PACKAGES.map((p) => path.join(repoRoot, "packages", p, "node_modules", depName)),
  ];
  const src = candidates.find((c) => existsSync(c));
  if (!src) {
    log(`  (skip) dep not found on disk: ${depName}`);
    return;
  }
  const dest = path.join(destModules, depName);
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, dereference: true });
}

function bundlePackage(pkg) {
  const distSrc = path.join(repoRoot, "packages", pkg, "dist");
  if (!existsSync(distSrc)) {
    throw new Error(`missing dist for ${pkg}; did the build succeed?`);
  }
  const dest = path.join(vendorDir, pkg);
  log(`vendoring ${pkg} → ${path.relative(pluginRoot, dest)}`);
  // Copy dist/* to vendor/<pkg>/ so the entry is vendor/<pkg>/index.js.
  cpSync(distSrc, dest, { recursive: true });

  // Copy runtime deps into vendor/<pkg>/node_modules/.
  const destModules = path.join(dest, "node_modules");
  mkdirSync(destModules, { recursive: true });
  for (const dep of RUNTIME_DEPS) copyDep(destModules, dep);
}

function main() {
  buildWorkspace();
  log("clearing vendor/…");
  rmSync(vendorDir, { recursive: true, force: true });
  mkdirSync(vendorDir, { recursive: true });
  for (const pkg of PACKAGES) bundlePackage(pkg);
  log("done. Vendored: " + PACKAGES.join(", "));
  log("Reminder: this bundle is platform-local (better-sqlite3 prebuilt binary).");
}

main();
