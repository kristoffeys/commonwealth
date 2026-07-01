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
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
    },
  },
});
