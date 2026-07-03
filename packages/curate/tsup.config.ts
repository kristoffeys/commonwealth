import { defineConfig } from "tsup";

export default defineConfig([
  {
    // CLI binary (`commonwealth-curate`). The shebang comes from the banner — a source shebang
    // would break the build — and this entry calls main() on load, so it is NEVER imported.
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: false,
    clean: true,
    sourcemap: true,
    target: "node22",
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    // Library surface (the curation engine), imported by other packages (#82). NO shebang — a
    // leading `#!` is a SyntaxError when a module is imported — and no main() side effects.
    entry: ["src/lib.ts"],
    format: ["esm"],
    dts: true,
    clean: false,
    sourcemap: true,
    target: "node22",
  },
]);
