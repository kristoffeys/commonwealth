import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build the whole workspace and vendor the plugin runtime ONCE, before any test file runs (#111).
 *
 * Several integration tests need built `dist/` artifacts (the CLI smoke test spawns
 * `packages/cli/dist/index.js`, `realdeps` spawns the built curate binary, `vendor-smoke` runs
 * the vendored MCP server). Each used to run `pnpm -r build` (or `bundle.mjs`, which builds
 * internally) in its own `beforeAll`; vitest runs files in parallel, so 2–3 concurrent builds
 * clobbered `dist/` mid-run and intermittently failed with `Cannot find module`.
 *
 * `bundle.mjs` runs `pnpm -r build` itself and then copies dist + the runtime closure into
 * `vendor/`, so a single invocation here produces fresh dist AND vendor for every test — with no
 * build happening DURING the test run to race against.
 */
export default function setup(): void {
  const repoRoot = path.dirname(fileURLToPath(import.meta.url));
  const bundle = path.join(repoRoot, "packages", "plugin", "scripts", "bundle.mjs");
  const res = spawnSync("node", [bundle], { cwd: repoRoot, stdio: "inherit" });
  if (res.status !== 0) {
    throw new Error(`vitest globalSetup: bundle.mjs failed (exit ${res.status ?? "null"})`);
  }
}
