import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Resolve workspace packages to their source so tests run without a build step.
      "@cmnwlth/core": new URL("./packages/core/src/index.ts", import.meta.url).pathname,
      "@cmnwlth/seed": new URL("./packages/seed/src/index.ts", import.meta.url).pathname,
      // curate's LIBRARY entry (lib.ts), not the CLI index.ts (#82).
      "@cmnwlth/curate": new URL("./packages/curate/src/lib.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["packages/**/test/**/*.test.ts"],
    environment: "node",
    // Build + vendor ONCE up front so no test spawns a concurrent `pnpm -r build` that clobbers
    // dist/ mid-run (#111). Replaces the per-file build hooks the integration suites used to run.
    globalSetup: ["./vitest.globalSetup.ts"],
    // Integration suites (sync spawns real git across clones; smoke tests build the
    // workspace) can take several seconds and run under parallel contention, so give
    // them generous headroom instead of the 5s default. Fast unit tests are unaffected.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Retry transient failures. Much of the suite spawns REAL subprocesses (git across clones,
    // the built CLI, the vendored MCP server, a sync daemon); under CI fork-pressure a spawn can
    // intermittently fail with EAGAIN and exit non-zero — a flake that twice aborted the release
    // gate. A real regression is deterministic and still fails all attempts; retry only rescues
    // the genuinely non-deterministic ones, and retries run ONLY on failure (green runs pay nothing).
    retry: 2,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
    },
  },
});
