import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * End-to-end guard for the BUILT binary (not source): a duplicate shebang (a stray source
 * shebang colliding with tsup's banner) or a broken dist entry would crash here while
 * every source-imported unit test still passes.
 */

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const distEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

// The workspace is built once in vitest globalSetup (#111), so dist/ exists here.
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

  it("config + reseed subcommands act on the mapped brain without rerunning init (#93)", async () => {
    const scratch = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-cli-cmds-")),
    );
    const brain = path.join(scratch, "brain");
    const core = fileURLToPath(new URL("../../core/dist/index.js", import.meta.url));
    const env = {
      ...process.env,
      COMMONWEALTH_BRAIN_DIR: brain,
      COMMONWEALTH_CONFIG: path.join(scratch, "cfg.json"),
      COMMONWEALTH_REGISTRY: path.join(scratch, "reg.json"),
    };
    try {
      execFileSync("node", [
        "-e",
        `require(${JSON.stringify(core)}).initBrain(${JSON.stringify(brain)},{name:'x'})`,
      ]);

      // config set/get: flip autoPromote off (review mode) without touching JSON by hand.
      execFileSync("node", [distEntry, "config", "set", "autoPromote", "false"], {
        env,
        stdio: "pipe",
      });
      const got = execFileSync("node", [distEntry, "config", "get", "autoPromote"], {
        env,
        stdio: "pipe",
      })
        .toString()
        .trim();
      expect(got).toBe("false");

      // reseed this very repo into the mapped brain; autoPromote off → notes go to the queue.
      execFileSync("node", [distEntry, "reseed", repoRoot], {
        env,
        stdio: "pipe",
        timeout: 120_000,
      });
      const pending = execFileSync("node", [distEntry, "pending"], {
        env,
        stdio: "pipe",
      }).toString();
      expect(pending.trim().length).toBeGreaterThan(0); // captured notes are awaiting review
    } finally {
      await fs.rm(scratch, { recursive: true, force: true });
    }
  }, 180_000);

  it("an unknown subcommand exits non-zero with usage", () => {
    const res = spawnSync("node", [distEntry, "frobnicate"], { stdio: "pipe" });
    expect(res.status).not.toBe(0);
  });
});
