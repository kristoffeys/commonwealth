import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the workspace package to its source so tests run without a build step.
      "@commons/core": new URL("./packages/core/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["packages/**/test/**/*.test.ts"],
    environment: "node",
    // Integration suites (sync spawns real git across clones; smoke tests build the
    // workspace) can take several seconds and run under parallel contention, so give
    // them generous headroom instead of the 5s default. Fast unit tests are unaffected.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
    },
  },
});
