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
      curateRuntime: () =>
        Promise.resolve({
          kind: "vendored",
          command: "/usr/bin/node /plugin/vendor/curate/index.js",
          ok: true,
          code: 0,
          version: "0.1.12",
        }),
      pidAlive: () => true,
      gitState: () => ({ kind: "tracked", behind: 0 }),
      startDaemon: () => Promise.resolve(true),
      syncDebt: () => Promise.resolve({ uncommittedNotes: 0, unpushed: 0, oldestMs: null }),
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
    expect(check(report, "curate-runtime").status).toBe("ok");
    expect(check(report, "daemon").status).toBe("ok");
    expect(check(report, "daemon").detail).toContain("Daemon profile");
    expect(check(report, "debt").status).toBe("ok");
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
    expect(report.checks.map((c) => c.id)).toEqual(["plugin", "curate-runtime", "brain"]);
  });

  it("treats a missing daemon as healthy lifecycle (daemonless) sync (ADR-0032)", async () => {
    // No pid file → no daemon. This is the healthy DEFAULT now, not a failure.
    const report = await diagnose(healthyEnv({ pidAlive: () => false }));
    expect(report.ok).toBe(true);
    const sync = check(report, "daemon");
    expect(sync.status).toBe("ok");
    expect(sync.detail).toContain("daemonless");
  });

  it("reports the daemon profile when a sync daemon is live (ADR-0032)", async () => {
    await fs.mkdir(path.join(brain, ".commonwealth"), { recursive: true });
    await fs.writeFile(path.join(brain, ".commonwealth", "sync.pid"), "4242\n");
    const report = await diagnose(healthyEnv({ pidAlive: (pid) => pid === 4242 }));
    const sync = check(report, "daemon");
    expect(sync.status).toBe("ok");
    expect(sync.detail).toContain("Daemon profile");
  });

  it("warns (not fails) on a stale daemon pidfile, and --fix restarts the daemon profile", async () => {
    await fs.mkdir(path.join(brain, ".commonwealth"), { recursive: true });
    await fs.writeFile(path.join(brain, ".commonwealth", "sync.pid"), "4242\n");

    // Dead recorded pid, no --fix → a soft warning; lifecycle sync still covers convergence.
    const warnReport = await diagnose(healthyEnv({ pidAlive: () => false }));
    expect(warnReport.ok).toBe(true);
    expect(check(warnReport, "daemon").status).toBe("warn");
    expect(check(warnReport, "daemon").detail).toContain("stale daemon pidfile");

    // Under --fix, the daemon profile is restarted.
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

  it("warns on aged sync debt, showing its age and pointing at `sync once` (ADR-0032)", async () => {
    const report = await diagnose(
      healthyEnv({
        syncDebt: () =>
          Promise.resolve({
            uncommittedNotes: 1,
            unpushed: 2,
            oldestMs: Date.now() - 25 * 60 * 60 * 1000, // 25h old → over the 24h threshold
          }),
      }),
    );
    const debt = check(report, "debt");
    expect(debt.status).toBe("warn");
    expect(debt.detail).toContain("1 uncommitted note(s)");
    expect(debt.detail).toContain("2 unpushed commit(s)");
    expect(debt.detail).toMatch(/\bold\b/);
    expect(debt.fix).toBe("commonwealth sync once");
    // A debt warning does not fail the overall report (it's a warning, not a critical link).
    expect(report.ok).toBe(true);
  });

  it("treats fresh sync debt as ok — it flushes at the next session (ADR-0032)", async () => {
    const report = await diagnose(
      healthyEnv({
        syncDebt: () =>
          Promise.resolve({ uncommittedNotes: 1, unpushed: 0, oldestMs: Date.now() - 60_000 }),
      }),
    );
    const debt = check(report, "debt");
    expect(debt.status).toBe("ok");
    expect(debt.detail).toContain("pending");
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

  it("adds optional host-prefixed diagnostics without changing the legacy checks/API (#226)", async () => {
    await fs.mkdir(path.join(brain, ".commonwealth"), { recursive: true });
    await fs.writeFile(path.join(brain, ".commonwealth", "sync.pid"), "4242\n");
    const report = await diagnose(
      healthyEnv({
        hostIntegrations: () =>
          Promise.resolve([
            {
              id: "claude-plugin",
              label: "Claude plugin",
              status: "ok",
              detail: "healthy",
            },
            {
              id: "codex-hooks",
              label: "Codex hooks",
              status: "warn",
              detail: "trust cannot be verified noninteractively",
              fix: "run /hooks",
            },
          ]),
      }),
    );

    expect(check(report, "plugin").status).toBe("ok");
    expect(check(report, "curate-runtime").status).toBe("ok");
    expect(check(report, "claude-plugin").status).toBe("ok");
    expect(check(report, "codex-hooks").fix).toContain("/hooks");
    expect(report.ok).toBe(true); // warnings preserve the existing critical-failure contract
  });

  it("names a healthy npx fallback as the live path and warns that cache is in-path (#222)", async () => {
    const report = await diagnose(
      healthyEnv({
        curateRuntime: () =>
          Promise.resolve({
            kind: "npx",
            command: "npx -y @cmnwlth/curate@0.1.12",
            ok: true,
            code: 0,
            version: "0.1.12\nTOKEN=must-not-render",
          }),
      }),
    );
    const runtime = check(report, "curate-runtime");
    expect(runtime.status).toBe("warn");
    expect(runtime.detail).toContain("npx -y @cmnwlth/curate@0.1.12");
    expect(runtime.detail).toContain("(0.1.12)");
    expect(runtime.detail).not.toContain("must-not-render");
    expect(runtime.detail).toContain("npm registry/cache fallback");
  });

  it("warns without claiming capture is off when an older plugin lacks the runtime probe", async () => {
    const report = await diagnose(
      healthyEnv({
        curateRuntime: () =>
          Promise.resolve({
            kind: "unsupported",
            command: "/plugin/hooks/lib.mjs",
            ok: false,
            code: null,
            error: "installed plugin predates curate runtime diagnostics; update it",
          }),
      }),
    );

    const runtime = check(report, "curate-runtime");
    expect(runtime.status).toBe("warn");
    expect(runtime.detail).toContain("Capture status was not inferred");
    expect(runtime.detail).not.toContain("Capture is OFF");
    expect(runtime.fix).toContain("commonwealth update");
  });

  it("fails loudly when the live npx runtime exits non-zero (#222)", async () => {
    const report = await diagnose(
      healthyEnv({
        curateRuntime: () =>
          Promise.resolve({
            kind: "npx",
            command: "npx -y @cmnwlth/curate@0.1.12",
            ok: false,
            code: 254,
            error: "package.json missing",
          }),
      }),
    );
    const runtime = check(report, "curate-runtime");
    expect(report.ok).toBe(false);
    expect(runtime.status).toBe("fail");
    expect(runtime.detail).toContain("exit 254");
    expect(runtime.detail).toContain("Capture is OFF");
    expect(runtime.detail).not.toContain("package.json missing");
    expect(runtime.detail).toContain("diagnostics were redacted");
    expect(runtime.fix).toContain("npx cache");
  });

  it("renders per-link fixes in the text report", async () => {
    // A hard failure (unparseable config) renders a ✗ line with its fix, plus the failed summary.
    const configPath = path.join(tmp, "config.json");
    const report = await diagnose(
      healthyEnv({
        configParse: () => Promise.resolve({ path: configPath, ok: false, error: "bad json" }),
      }),
    );
    const text = formatDoctorText(report);
    expect(text).toContain("✗ Config");
    expect(text).toContain("fix:");
    expect(text).toContain("failed");
  });

  it("renders a warning line with its fix for aged sync debt", async () => {
    const report = await diagnose(
      healthyEnv({
        syncDebt: () =>
          Promise.resolve({
            uncommittedNotes: 0,
            unpushed: 1,
            oldestMs: Date.now() - 48 * 60 * 60 * 1000,
          }),
      }),
    );
    const text = formatDoctorText(report);
    expect(text).toContain("⚠ Sync debt");
    expect(text).toContain("commonwealth sync once");
  });

  // Last-capture link from the persistent capture log (#211).
  it("reports the last capture as ok when the newest log entry succeeded", async () => {
    const report = await diagnose(
      healthyEnv({
        lastCaptures: () =>
          Promise.resolve([{ ts: Date.now(), outcome: "ok", captured: 3, promoted: 2, staged: 1 }]),
      }),
    );
    const c = check(report, "last-capture");
    expect(c.status).toBe("ok");
    expect(c.detail).toContain("3 note(s)");
  });

  it("warns on a single extraction failure and names the class + fix", async () => {
    const report = await diagnose(
      healthyEnv({
        lastCaptures: () =>
          Promise.resolve([
            { ts: Date.now(), outcome: "extraction-failed", reason: "extractor-unavailable" },
          ]),
      }),
    );
    const c = check(report, "last-capture");
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("extractor-unavailable");
    expect(c.fix).toContain("claude /login");
  });

  it("fails and reports the streak when captures keep failing with the same class (#211)", async () => {
    const now = Date.now();
    const report = await diagnose(
      healthyEnv({
        lastCaptures: () =>
          Promise.resolve([
            { ts: now - 3000, outcome: "extraction-failed", reason: "extractor-timeout" },
            { ts: now - 2000, outcome: "extraction-failed", reason: "extractor-timeout" },
            { ts: now - 1000, outcome: "extraction-failed", reason: "extractor-timeout" },
          ]),
      }),
    );
    const c = check(report, "last-capture");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("last 3 captures all failed with extractor-timeout");
    expect(report.ok).toBe(false);
  });

  it("treats a benign skip as informational, not a failure", async () => {
    const report = await diagnose(
      healthyEnv({
        lastCaptures: () =>
          Promise.resolve([{ ts: Date.now(), outcome: "skipped", reason: "out-of-scope" }]),
      }),
    );
    const c = check(report, "last-capture");
    expect(c.status).toBe("skip");
    expect(c.detail).toContain("out-of-scope");
  });

  it("skips the link when no captures are recorded yet", async () => {
    const report = await diagnose(healthyEnv({ lastCaptures: () => Promise.resolve([]) }));
    expect(check(report, "last-capture").status).toBe("skip");
  });
});
