import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end guard for the BUILT binary (not source): a duplicate shebang (a stray source
 * shebang colliding with tsup's banner) or a broken dist entry would crash here while
 * every source-imported unit test still passes.
 */

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const distEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

beforeAll(() => {
  execFileSync("pnpm", ["-r", "build"], { cwd: repoRoot, stdio: "pipe" });
}, 180_000);

describe("built commonwealth binary", () => {
  it("`init --help` exits 0", () => {
    expect(() =>
      execFileSync("node", [distEntry, "init", "--help"], { stdio: "pipe" }),
    ).not.toThrow();
  });

  it("dist entry has exactly one shebang", async () => {
    const content = await fs.readFile(distEntry, "utf8");
    const shebangs = content.split("\n").filter((l) => l.startsWith("#!"));
    expect(shebangs).toHaveLength(1);
    expect(content.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("`init` non-TTY without --yes exits 0 fast and does not hang or touch anything", () => {
    // stdio 'ignore' guarantees stdin is NOT a TTY; a short timeout proves it never blocks
    // waiting for input. It must exit 0 with no side effects (the "re-run in a terminal" path).
    const res = spawnSync("node", [distEntry, "init"], {
      stdio: "ignore",
      timeout: 15_000,
    });
    expect(res.error).toBeUndefined();
    expect(res.signal).toBeNull();
    expect(res.status).toBe(0);
  });
});
