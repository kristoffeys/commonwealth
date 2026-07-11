import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diagnose, formatDoctorText, type DoctorEnv } from "../src/doctor.js";

/**
 * `commonwealth doctor` (#134). `diagnose` is pure w.r.t. an injected {@link DoctorEnv}, so these
 * run against a throwaway fixture brain with fake plugin/pid/git probes — no `claude`, `git`, or
 * real home directory is touched.
 */
describe("commonwealth doctor — diagnose()", () => {
  let tmp: string;
  let brain: string;
  let cwd: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cw-doctor-"));
    brain = path.join(tmp, "brain");
    cwd = path.join(tmp, "project");
    await fs.mkdir(path.join(brain, "acme", "memory"), { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    // A note (for index-freshness), then an index db written AFTER it so the index is "current".
    await fs.writeFile(path.join(brain, "acme", "memory", "n1.md"), "---\nid: x\n---\nbody\n");
    await fs.mkdir(path.join(brain, "index"), { recursive: true });
    await fs.writeFile(path.join(brain, "index", "commonwealth.db"), "db");
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  /** A fully-healthy env; individual tests override single surfaces. */
  function healthyEnv(overrides: Partial<DoctorEnv> = {}): DoctorEnv {
    return {
      cwd,
      resolveBrain: () => Promise.resolve(brain),
      resolveScope: () => Promise.resolve("brain"),
      // Default: no config file present (a valid pre-init state) → no config check emitted, so the
      // existing checks/ids are unchanged. Corrupt/healthy cases override this per-test.
      configParse: () => Promise.resolve(null),
      pluginInstalled: () => true,
      pidAlive: () => true,
      gitState: () => ({ kind: "tracked", behind: 0 }),
      startDaemon: () => Promise.resolve(true),
      ...overrides,
    };
  }

  const check = (r: Awaited<ReturnType<typeof diagnose>>, id: string) =>
    r.checks.find((c) => c.id === id)!;

  it("reports all-ok for a fully-healthy chain", async () => {
    // A live daemon requires the pid file to exist.
    await fs.mkdir(path.join(brain, ".commonwealth"), { recursive: true });
    await fs.writeFile(path.join(brain, ".commonwealth", "sync.pid"), "4242\n");

    const report = await diagnose(healthyEnv({ pidAlive: (pid) => pid === 4242 }));

    expect(report.ok).toBe(true);
    expect(check(report, "brain").status).toBe("ok");
    expect(check(report, "daemon").status).toBe("ok");
    expect(check(report, "remote").status).toBe("ok");
    expect(check(report, "index").status).toBe("ok");
    expect(check(report, "scope").status).toBe("ok");
    expect(report.checks.some((c) => c.status === "fail")).toBe(false);
  });

  it("reports 'not cloned yet' when the brain is mapped with a remote but missing (ADR-0019)", async () => {
    const missing = path.join(tmp, "not-cloned");
    const report = await diagnose(
      healthyEnv({
        resolveBrain: () => Promise.resolve(missing),
        resolveRemote: () => Promise.resolve("git@example.com:org/brain.git"),
      }),
    );
    const brainCheck = check(report, "brain");
    expect(brainCheck.status).toBe("fail");
    expect(brainCheck.detail).toContain("not cloned yet");
    expect(brainCheck.fix).toContain("commonwealth sync once");
  });

  it("fails and short-circuits when no brain resolves", async () => {
    const report = await diagnose(healthyEnv({ resolveBrain: () => Promise.resolve(null) }));
    expect(report.ok).toBe(false);
    expect(check(report, "brain").status).toBe("fail");
    expect(check(report, "brain").fix).toContain("commonwealth init");
    // Brain-scoped links are not evaluated once resolution fails.
    expect(report.checks.map((c) => c.id)).toEqual(["plugin", "brain"]);
  });

  it("flags a dead daemon and heals it under --fix", async () => {
    // No pid file → daemon not running.
    const failReport = await diagnose(healthyEnv({ pidAlive: () => false }));
    expect(check(failReport, "daemon").status).toBe("fail");
    expect(failReport.ok).toBe(false);

    let started: string | null = null;
    const healReport = await diagnose(
      healthyEnv({
        pidAlive: () => false,
        startDaemon: (dir) => {
          started = dir;
          return Promise.resolve(true);
        },
      }),
      { fix: true },
    );
    expect(started).toBe(brain);
    expect(check(healReport, "daemon").status).toBe("ok");
    expect(healReport.healed).toBe(true);
  });

  it("warns on a dangling brain marker that shadows nothing (#68)", async () => {
    await fs.mkdir(path.join(cwd, ".commonwealth"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".commonwealth", "brain"), `${tmp}/does-not-exist\n`);
    const report = await diagnose(healthyEnv());
    const marker = check(report, "marker");
    expect(marker.status).toBe("warn");
    expect(marker.fix).toContain("rm ");
  });

  it("warns when behind the upstream, pointing at `sync once`", async () => {
    const report = await diagnose(healthyEnv({ gitState: () => ({ kind: "tracked", behind: 3 }) }));
    const remote = check(report, "remote");
    expect(remote.status).toBe("warn");
    expect(remote.detail).toContain("3 commit");
    expect(remote.fix).toBe("commonwealth sync once");
  });

  it("warns when the index is older than the newest note", async () => {
    // Make the note newer than the db.
    const noteFile = path.join(brain, "acme", "memory", "n1.md");
    const dbFile = path.join(brain, "index", "commonwealth.db");
    const old = new Date(2020, 0, 1);
    const recent = new Date(2030, 0, 1);
    await fs.utimes(dbFile, old, old);
    await fs.utimes(noteFile, recent, recent);
    const report = await diagnose(healthyEnv());
    expect(check(report, "index").status).toBe("warn");
    expect(check(report, "index").detail).toContain("older than the newest note");
  });

  it("warns when the cwd maps to no rule (out of scope, none)", async () => {
    const report = await diagnose(healthyEnv({ resolveScope: () => Promise.resolve("none") }));
    const scope = check(report, "scope");
    expect(scope.status).toBe("warn");
    expect(scope.detail).toContain("no rule maps it");
    expect(scope.fix).toContain("commonwealth add");
  });

  it("warns when the cwd is explicitly denied (out of scope, deny rule)", async () => {
    const report = await diagnose(healthyEnv({ resolveScope: () => Promise.resolve("denied") }));
    const scope = check(report, "scope");
    expect(scope.status).toBe("warn");
    expect(scope.detail).toContain("deny rule");
    expect(scope.fix).toContain("commonwealth registry");
  });

  it("fails, naming the file, when the per-user config is unparseable (#210)", async () => {
    const configPath = path.join(tmp, "config.json");
    const report = await diagnose(
      healthyEnv({
        configParse: () =>
          Promise.resolve({
            path: configPath,
            ok: false,
            error: "Unexpected token } in JSON at position 42 (line 3 column 5)",
          }),
      }),
    );
    expect(report.ok).toBe(false);
    const config = check(report, "config");
    expect(config.status).toBe("fail");
    expect(config.detail).toContain(configPath);
    expect(config.detail).toContain("line 3 column 5");
    expect(config.fix).toContain("trailing comma");
  });

  it("passes the config check for a healthy, parseable config", async () => {
    const configPath = path.join(tmp, "config.json");
    const report = await diagnose(
      healthyEnv({ configParse: () => Promise.resolve({ path: configPath, ok: true }) }),
    );
    const config = check(report, "config");
    expect(config.status).toBe("ok");
    expect(report.checks.some((c) => c.id === "config" && c.status === "fail")).toBe(false);
  });

  it("presents the plugin link as inferred (skip) when claude is absent", async () => {
    const report = await diagnose(healthyEnv({ pluginInstalled: () => null }));
    expect(check(report, "plugin").status).toBe("skip");
  });

  it("renders the fixes in the text report", async () => {
    const report = await diagnose(healthyEnv({ pidAlive: () => false }));
    const text = formatDoctorText(report);
    expect(text).toContain("✗ Daemon");
    expect(text).toContain("fix:");
    expect(text).toContain("failed");
  });
});
