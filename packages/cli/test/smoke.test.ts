import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
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

  it("`init --yes` always leaves the per-user scope config file behind", async () => {
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cw-home-")));
    const project = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cw-proj-")));
    const configPath = path.join(home, ".commonwealth", "config.json");
    try {
      execFileSync("git", ["init", "-q", project], { stdio: "pipe" });

      const res = spawnSync(
        "node",
        [distEntry, "init", "--yes", "--no-mcp", "--no-daemon", "--no-build", "--no-seed"],
        {
          cwd: project,
          stdio: "pipe",
          timeout: 30_000,
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            COMMONWEALTH_CONFIG: configPath,
          },
        },
      );
      expect(res.status).toBe(0);
      expect(existsSync(configPath)).toBe(true);

      const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as unknown;
      expect(parsed).toHaveProperty("allow");
      expect(parsed).toHaveProperty("deny");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(project, { recursive: true, force: true });
    }
  });
});
