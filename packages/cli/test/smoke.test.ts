import { execFileSync } from "node:child_process";
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
});
