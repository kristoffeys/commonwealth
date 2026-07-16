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

  it("`--version` prints the package version on stdout (#161)", async () => {
    const pkg = JSON.parse(
      await fs.readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { version: string };
    for (const flag of ["--version", "-v", "version"]) {
      const out = execFileSync("node", [distEntry, flag], { stdio: "pipe" }).toString().trim();
      expect(out).toBe(pkg.version);
    }
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
        [distEntry, "init", "--yes", "--no-plugin", "--no-daemon", "--no-build", "--no-seed"],
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

      // health rollup (#109): the unified verb delegates to curate and prints a score.
      const health = execFileSync("node", [distEntry, "health"], { env, stdio: "pipe" }).toString();
      expect(health).toMatch(/Brain health: \d+\/100/);

      // doctor --json (#134): the built binary emits a structured report resolving the mapped
      // brain and walking the chain. No daemon runs here, but under the daemonless model (ADR-0032)
      // that is the HEALTHY default — lifecycle sync covers convergence — so the sync link is OK.
      const doc = spawnSync("node", [distEntry, "doctor", "--json"], { env, stdio: "pipe" });
      const report = JSON.parse(doc.stdout.toString()) as {
        ok: boolean;
        brain: string;
        checks: Array<{ id: string; status: string; detail: string }>;
      };
      expect(report.brain).toBe(brain);
      expect(report.checks.map((c) => c.id)).toEqual(
        expect.arrayContaining(["brain", "daemon", "debt", "remote", "index", "scope"]),
      );
      // Sync health follows the daemonless model (ADR-0032): with no daemon the sync link is OK
      // (lifecycle sync covers convergence), and fresh uncommitted notes are pending debt, not a
      // failure. (The overall exit code isn't asserted here — host-integration links depend on the
      // machine's globally-installed plugin state; the sync links are what this change owns.)
      const sync = report.checks.find((c) => c.id === "daemon");
      expect(sync?.status).toBe("ok");
      expect(sync?.detail).toContain("daemonless");
      expect(report.checks.find((c) => c.id === "debt")?.status).not.toBe("fail");
      expect(report.checks.find((c) => c.id === "remote")?.status).not.toBe("fail");
    } finally {
      await fs.rm(scratch, { recursive: true, force: true });
    }
  }, 180_000);

  it("`add` wires a folder to an existing brain in one go (#157)", async () => {
    const scratch = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-cli-add-")),
    );
    const brain = path.join(scratch, "brain");
    const project = path.join(scratch, "work", "app");
    const core = fileURLToPath(new URL("../../core/dist/index.js", import.meta.url));
    const env = {
      ...process.env,
      COMMONWEALTH_CONFIG: path.join(scratch, "cfg.json"),
      COMMONWEALTH_REGISTRY: path.join(scratch, "reg.json"),
    };
    delete env.COMMONWEALTH_BRAIN_DIR;
    try {
      await fs.mkdir(project, { recursive: true });
      execFileSync("node", [
        "-e",
        `require(${JSON.stringify(core)}).initBrain(${JSON.stringify(brain)},{name:'x'})`,
      ]);

      const res = spawnSync("node", [distEntry, "add", project, "--brain", brain], {
        env,
        stdio: "pipe",
      });
      expect(res.status).toBe(0);

      // One command → both stores: the capture allowlist AND the registry mapping.
      const cfg = JSON.parse(await fs.readFile(path.join(scratch, "cfg.json"), "utf8")) as {
        allow: string[];
      };
      expect(cfg.allow).toContain(project);
      const reg = JSON.parse(await fs.readFile(path.join(scratch, "reg.json"), "utf8")) as {
        rules: Array<{ prefix?: string; repo?: string; brain: string }>;
      };
      expect(reg.rules).toEqual([{ prefix: project, brain }]);
    } finally {
      await fs.rm(scratch, { recursive: true, force: true });
    }
  });

  it("an unknown subcommand exits non-zero with usage", () => {
    const res = spawnSync("node", [distEntry, "frobnicate"], { stdio: "pipe" });
    expect(res.status).not.toBe(0);
  });

  it("runs when invoked through a symlink, like an npm-installed global bin", async () => {
    // npm bins are symlinks; the ESM loader realpaths import.meta.url while argv[1] stays
    // the link, so a naive entrypoint guard never fires and every command silently exits 0.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cw-bin-"));
    const link = path.join(dir, "commonwealth");
    try {
      await fs.symlink(distEntry, link);
      const res = spawnSync("node", [link, "frobnicate"], { stdio: "pipe" });
      expect(res.status).not.toBe(0);
      expect(res.stderr.toString()).toContain("Usage");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
