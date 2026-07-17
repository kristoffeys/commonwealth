import { describe, expect, it, vi } from "vitest";
import type { InitResult } from "../src/init.js";
import {
  parseAgentTarget,
  runOnboard,
  type OnboardDeps,
  type OnboardOptions,
} from "../src/onboard.js";

const INIT_RESULT: InitResult = { mode: "new", brainDir: "/b", staged: 4, gathered: 4 };

/** Build injectable onboard deps with vitest spies; override any piece per test. */
function makeDeps(over: Partial<OnboardDeps> = {}): OnboardDeps {
  return {
    ensureBuilt: vi.fn(async () => ({ built: true })),
    init: vi.fn(async () => INIT_RESULT),
    configureScope: vi.fn(async () => ({ added: true })),
    registerBrain: vi.fn(async () => ({ mapped: true, linked: true })),
    seedFrom: vi.fn(async () => ({ staged: 4 })),
    ensureUserConfig: vi.fn(async () => ({ path: "/home/.commonwealth/config.json" })),
    setAutoAdr: vi.fn(async () => ({ set: true })),
    setRemote: vi.fn(async () => ({ set: true })),
    writeCiWorkflow: vi.fn(async () => ({ written: true })),
    installPlugin: vi.fn(async () => ({ installed: true })),
    emitContext: vi.fn(async () => ({ written: ["AGENTS.md"] })),
    startDaemon: vi.fn(async () => ({ started: true })),
    confirm: vi.fn(async () => true),
    log: vi.fn(),
    ...over,
  };
}

describe("runOnboard", () => {
  it("full run (defaults): builds, inits, installs plugin, starts daemon, aggregates", async () => {
    const deps = makeDeps();
    const result = await runOnboard("/repo", { yes: true }, deps);

    expect(deps.ensureBuilt).toHaveBeenCalledTimes(1);
    expect(deps.init).toHaveBeenCalledTimes(1);
    expect(deps.configureScope).toHaveBeenCalledTimes(1);
    expect(deps.registerBrain).toHaveBeenCalledTimes(1);
    expect(deps.seedFrom).toHaveBeenCalledTimes(1);
    expect(deps.ensureUserConfig).toHaveBeenCalledTimes(1);
    expect(deps.installPlugin).toHaveBeenCalledTimes(1);
    expect(deps.startDaemon).toHaveBeenCalledWith("/b");

    expect(result).toEqual({
      brainDir: "/b",
      mode: "new",
      built: true,
      staged: 4,
      scopedFolders: 1,
      mappedFolders: 1,
      seededRepos: 1,
      scopeConfigPath: "/home/.commonwealth/config.json",
      scope: "added 1",
      autoAdr: "skipped",
      remote: "skipped",
      ci: "no remote",
      plugin: "installed",
      context: "skipped",
      daemon: "started",
    });
  });

  it("respects an explicit empty syncFolders ('none') instead of scoping cwd (#103)", async () => {
    const deps = makeDeps();
    const result = await runOnboard("/repo", { yes: true, syncFolders: [] }, deps);
    // The user chose to scope NO extra folders — the loop must not run and cwd is not force-scoped.
    expect(deps.configureScope).not.toHaveBeenCalled();
    expect(deps.seedFrom).not.toHaveBeenCalled(); // seedRepos defaults to syncFolders → []
    expect(result.scopedFolders).toBe(0);
    // The brain is still created/joined and the cwd wired via init (not the syncFolders loop).
    expect(deps.init).toHaveBeenCalledTimes(1);
  });

  it("defaults syncFolders to the cwd when the flag is omitted (undefined ≠ [])", async () => {
    const deps = makeDeps();
    await runOnboard("/repo", { yes: true }, deps);
    expect(deps.configureScope).toHaveBeenCalledTimes(1); // cwd scoped by default
  });

  it("--yes: never calls confirm; all steps run", async () => {
    const deps = makeDeps();
    await runOnboard("/repo", { yes: true }, deps);

    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.ensureBuilt).toHaveBeenCalledTimes(1);
    expect(deps.init).toHaveBeenCalledTimes(1);
    expect(deps.installPlugin).toHaveBeenCalledTimes(1);
    expect(deps.startDaemon).toHaveBeenCalledTimes(1);
  });

  it("no --yes with confirm=true: prompts once, then runs everything", async () => {
    const deps = makeDeps({ confirm: vi.fn(async () => true) });
    await runOnboard("/repo", {}, deps);

    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(deps.init).toHaveBeenCalledTimes(1);
  });

  it("decline (confirm=false): NO steps run and result is a no-op", async () => {
    const deps = makeDeps({ confirm: vi.fn(async () => false) });
    const result = await runOnboard("/repo", { brain: "/b" }, deps);

    expect(deps.ensureBuilt).not.toHaveBeenCalled();
    expect(deps.init).not.toHaveBeenCalled();
    expect(deps.installPlugin).not.toHaveBeenCalled();
    expect(deps.startDaemon).not.toHaveBeenCalled();

    expect(result.mode).toBe("skipped");
    expect(result.built).toBe(false);
    expect(result.plugin).toBe("skipped");
    expect(result.daemon).toBe("skipped");
  });

  it("--no-build: skips ensureBuilt, runs the rest", async () => {
    const deps = makeDeps();
    const result = await runOnboard("/repo", { yes: true, build: false }, deps);

    expect(deps.ensureBuilt).not.toHaveBeenCalled();
    expect(deps.init).toHaveBeenCalledTimes(1);
    expect(deps.installPlugin).toHaveBeenCalledTimes(1);
    expect(deps.startDaemon).toHaveBeenCalledTimes(1);
    expect(result.built).toBe(false);
  });

  it("--no-seed: passes seed:false through to init", async () => {
    const init = vi.fn(async () => ({ ...INIT_RESULT, mode: "skipped" as const, staged: 0 }));
    const deps = makeDeps({ init });
    const result = await runOnboard("/repo", { yes: true, seed: false }, deps);

    expect(init).toHaveBeenCalledWith("/repo", expect.objectContaining({ seed: false }));
    expect(result.staged).toBe(0);
  });

  it("--no-plugin: skips installPlugin, runs the rest", async () => {
    const deps = makeDeps();
    const result = await runOnboard("/repo", { yes: true, plugin: false }, deps);

    expect(deps.installPlugin).not.toHaveBeenCalled();
    expect(deps.init).toHaveBeenCalledTimes(1);
    expect(deps.startDaemon).toHaveBeenCalledTimes(1);
    expect(result.plugin).toBe("skipped");
  });

  it("--agent codex installs Codex and emits the AGENTS.md fallback", async () => {
    const deps = makeDeps({
      installPlugin: vi.fn(async () => ({ installed: true, detail: "installed (codex)" })),
    });
    const result = await runOnboard("/repo", { yes: true, agent: "codex" }, deps);

    expect(deps.installPlugin).toHaveBeenCalledWith("codex");
    expect(deps.emitContext).toHaveBeenCalledWith("/repo");
    expect(result.plugin).toBe("installed (codex)");
    expect(result.context).toBe("AGENTS.md emitted");
  });

  it("--agent both preserves a partial install result and still emits Codex context", async () => {
    const deps = makeDeps({
      installPlugin: vi.fn(async () => ({
        installed: true,
        detail: "installed (codex); skipped claude: claude CLI not found",
      })),
    });
    const result = await runOnboard("/repo", { yes: true, agent: "both" }, deps);

    expect(deps.installPlugin).toHaveBeenCalledWith("both");
    expect(result.plugin).toContain("installed (codex)");
    expect(result.plugin).toContain("claude CLI not found");
    expect(result.context).toBe("AGENTS.md emitted");
  });

  it("--agent codex emits AGENTS.md even when plugin installation is disabled", async () => {
    const deps = makeDeps();
    const result = await runOnboard("/repo", { yes: true, agent: "codex", plugin: false }, deps);

    expect(deps.installPlugin).not.toHaveBeenCalled();
    expect(deps.emitContext).toHaveBeenCalledWith("/repo");
    expect(result.context).toBe("AGENTS.md emitted");
  });

  it("surfaces Codex context emission failures without aborting onboarding", async () => {
    const deps = makeDeps({
      emitContext: vi.fn(async () => ({ written: [], skipped: "brain render failed" })),
    });
    const result = await runOnboard("/repo", { yes: true, agent: "codex" }, deps);

    expect(result.context).toBe("brain render failed");
    expect(result.mode).toBe("new");
  });

  it("--no-daemon: skips startDaemon, runs the rest", async () => {
    const deps = makeDeps();
    const result = await runOnboard("/repo", { yes: true, daemon: false }, deps);

    expect(deps.startDaemon).not.toHaveBeenCalled();
    expect(deps.installPlugin).toHaveBeenCalledTimes(1);
    expect(result.daemon).toBe("skipped");
  });

  it("runs steps in order: ensureBuilt -> init -> scope -> autoAdr -> remote -> plugin -> daemon", async () => {
    const calls: string[] = [];
    const deps = makeDeps({
      ensureBuilt: vi.fn(async () => {
        calls.push("build");
        return { built: true };
      }),
      init: vi.fn(async () => {
        calls.push("init");
        return INIT_RESULT;
      }),
      configureScope: vi.fn(async () => {
        calls.push("scope");
        return { added: true };
      }),
      setAutoAdr: vi.fn(async () => {
        calls.push("autoAdr");
        return { set: true };
      }),
      setRemote: vi.fn(async () => {
        calls.push("remote");
        return { set: true };
      }),
      installPlugin: vi.fn(async () => {
        calls.push("plugin");
        return { installed: true };
      }),
      startDaemon: vi.fn(async () => {
        calls.push("daemon");
        return { started: true };
      }),
    });

    await runOnboard("/repo", { yes: true, autoAdr: true, remote: "git@x:y.git" }, deps);
    expect(calls).toEqual(["build", "init", "scope", "autoAdr", "remote", "plugin", "daemon"]);
  });

  it("scope/autoAdr/remote: runs each when its opt is set, reflects status", async () => {
    const deps = makeDeps();
    const result = await runOnboard(
      "/repo",
      { yes: true, scope: true, autoAdr: true, remote: "git@x:y.git" },
      deps,
    );

    expect(deps.configureScope).toHaveBeenCalledTimes(1);
    expect(deps.setAutoAdr).toHaveBeenCalledWith("/b", true);
    expect(deps.setRemote).toHaveBeenCalledWith("/b", "git@x:y.git");
    expect(result.scope).toBe("added 1");
    expect(result.autoAdr).toBe("enabled");
    expect(result.remote).toBe("set");
  });

  it("scope/autoAdr/remote: SKIPS each when unset/false; only scope defaults on", async () => {
    const deps = makeDeps();
    // autoAdr defaults false, remote defaults undefined; explicitly turn scope off too.
    const result = await runOnboard("/repo", { yes: true, scope: false }, deps);

    expect(deps.configureScope).not.toHaveBeenCalled();
    expect(deps.setAutoAdr).not.toHaveBeenCalled();
    expect(deps.setRemote).not.toHaveBeenCalled();
    expect(result.scope).toBe("skipped");
    expect(result.autoAdr).toBe("skipped");
    expect(result.remote).toBe("skipped");
  });

  it("remote: an empty/whitespace remote string is treated as skip", async () => {
    const deps = makeDeps();
    const result = await runOnboard("/repo", { yes: true, remote: "   " }, deps);

    expect(deps.setRemote).not.toHaveBeenCalled();
    expect(result.remote).toBe("skipped");
  });

  it("CI (#220): writes the disaster-recovery workflow when the brain has a remote", async () => {
    const deps = makeDeps();
    const result = await runOnboard("/repo", { yes: true, remote: "git@x:y.git" }, deps);

    expect(deps.writeCiWorkflow).toHaveBeenCalledWith("/b");
    expect(result.ci).toBe("written");
  });

  it("CI (#220): --no-ci (ci:false) skips the workflow even with a remote", async () => {
    const deps = makeDeps();
    const result = await runOnboard("/repo", { yes: true, remote: "git@x:y.git", ci: false }, deps);

    expect(deps.writeCiWorkflow).not.toHaveBeenCalled();
    expect(result.ci).toBe("skipped");
  });

  it("CI (#220): no remote means no workflow (nothing for CI to clone)", async () => {
    const deps = makeDeps();
    const result = await runOnboard("/repo", { yes: true }, deps);

    expect(deps.writeCiWorkflow).not.toHaveBeenCalled();
    expect(result.ci).toBe("no remote");
  });

  it("CI (#220): a pre-existing workflow is reported as 'exists', not overwritten", async () => {
    const deps = makeDeps({
      writeCiWorkflow: vi.fn(async () => ({ written: false, skipped: "exists" })),
    });
    const result = await runOnboard("/repo", { yes: true, remote: "git@x:y.git" }, deps);

    expect(result.ci).toBe("exists");
  });

  it("scope idempotency: an already-allowed scope emits a WARNING and counts zero added", async () => {
    const log = vi.fn();
    const deps = makeDeps({
      configureScope: vi.fn(async () => ({ added: false, skipped: "already allowed" })),
      setRemote: vi.fn(async () => ({ set: false, skipped: "origin exists" })),
      log,
    });
    const result = await runOnboard("/repo", { yes: true, remote: "git@x:y.git" }, deps);

    expect(result.scope).toBe("none added");
    expect(result.scopedFolders).toBe(0);
    expect(result.remote).toBe("origin exists");
    const warned = log.mock.calls
      .map((c) => c[0] as string)
      .some((m) => m.startsWith("WARNING: scope step skipped") && m.includes("already allowed"));
    expect(warned).toBe(true);
  });

  it("decline (confirm=false): none of the loop deps or ensureUserConfig are called", async () => {
    const deps = makeDeps({ confirm: vi.fn(async () => false) });
    await runOnboard("/repo", { brain: "/b", autoAdr: true, remote: "git@x:y.git" }, deps);

    expect(deps.configureScope).not.toHaveBeenCalled();
    expect(deps.registerBrain).not.toHaveBeenCalled();
    expect(deps.seedFrom).not.toHaveBeenCalled();
    expect(deps.ensureUserConfig).not.toHaveBeenCalled();
    expect(deps.setAutoAdr).not.toHaveBeenCalled();
    expect(deps.setRemote).not.toHaveBeenCalled();
  });

  it("multi syncFolders: loops configureScope + registerBrain over every folder", async () => {
    const deps = makeDeps();
    const folders = ["/a", "/b", "/c"];
    const result = await runOnboard("/repo", { yes: true, syncFolders: folders }, deps);

    expect(deps.configureScope).toHaveBeenCalledTimes(3);
    expect(deps.registerBrain).toHaveBeenCalledTimes(3);
    for (const f of folders) {
      expect(deps.configureScope).toHaveBeenCalledWith(f);
      // Third arg is the brain remote (undefined here — no --remote in this run; ADR-0019).
      expect(deps.registerBrain).toHaveBeenCalledWith(f, "/b", undefined);
    }
    expect(result.scopedFolders).toBe(3);
    expect(result.mappedFolders).toBe(3);
  });

  it("passes the brain remote to registerBrain so it lands in the mapping (ADR-0019)", async () => {
    const deps = makeDeps();
    await runOnboard(
      "/repo",
      { yes: true, brain: "/b", syncFolders: ["/a"], remote: "git@example.com:org/brain.git" },
      deps,
    );
    expect(deps.registerBrain).toHaveBeenCalledWith("/a", "/b", "git@example.com:org/brain.git");
  });

  it("registerBrain runs once per syncFolder", async () => {
    const deps = makeDeps();
    await runOnboard("/repo", { yes: true, syncFolders: ["/a", "/b"] }, deps);
    expect(deps.registerBrain).toHaveBeenCalledTimes(2);
  });

  it("a registerBrain result with skipped emits a WARNING but still counts the mapping", async () => {
    const log = vi.fn();
    const deps = makeDeps({
      registerBrain: vi.fn(async () => ({ mapped: true, linked: false, skipped: "EPERM" })),
      log,
    });
    const result = await runOnboard("/repo", { yes: true, syncFolders: ["/a"] }, deps);

    const warned = log.mock.calls
      .map((c) => c[0] as string)
      .some((m) => m.startsWith("WARNING: brain symlink skipped") && m.includes("EPERM"));
    expect(warned).toBe(true);
    expect(result.mappedFolders).toBe(1);
  });

  it("multi seedRepos: loops seedFrom over every repo and sums staged", async () => {
    const seedFrom = vi.fn(async () => ({ staged: 2 }));
    const deps = makeDeps({ seedFrom });
    const repos = ["/r1", "/r2", "/r3"];
    const result = await runOnboard("/repo", { yes: true, seedRepos: repos }, deps);

    expect(seedFrom).toHaveBeenCalledTimes(3);
    for (const r of repos) expect(seedFrom).toHaveBeenCalledWith("/b", r);
    expect(result.staged).toBe(6);
    expect(result.seededRepos).toBe(3);
  });

  it("ensureUserConfig is ALWAYS called, even with --no-scope and no seed", async () => {
    const deps = makeDeps();
    const result = await runOnboard("/repo", { yes: true, scope: false, seed: false }, deps);

    expect(deps.configureScope).not.toHaveBeenCalled();
    expect(deps.seedFrom).not.toHaveBeenCalled();
    expect(deps.ensureUserConfig).toHaveBeenCalledTimes(1);
    expect(result.scopeConfigPath).toBe("/home/.commonwealth/config.json");
  });

  it("a skipped seedFrom emits a WARNING line", async () => {
    const log = vi.fn();
    const deps = makeDeps({
      seedFrom: vi.fn(async () => ({ staged: 0, skipped: "seed CLI not built" })),
      log,
    });
    const result = await runOnboard("/repo", { yes: true, seedRepos: ["/r1"] }, deps);

    const warned = log.mock.calls
      .map((c) => c[0] as string)
      .some((m) => m.startsWith("WARNING: seed step skipped") && m.includes("seed CLI not built"));
    expect(warned).toBe(true);
    expect(result.seededRepos).toBe(0);
    expect(result.staged).toBe(0);
  });

  it("a skipped configureScope emits a WARNING line", async () => {
    const log = vi.fn();
    const deps = makeDeps({
      configureScope: vi.fn(async () => ({ added: false, skipped: "curate not found" })),
      log,
    });
    await runOnboard("/repo", { yes: true, syncFolders: ["/a"] }, deps);

    const warned = log.mock.calls
      .map((c) => c[0] as string)
      .some((m) => m.startsWith("WARNING: scope step skipped") && m.includes("curate not found"));
    expect(warned).toBe(true);
  });

  it("idempotency surfaced: skipped plugin install + already-running daemon reflected without error", async () => {
    const deps = makeDeps({
      ensureBuilt: vi.fn(async () => ({ built: false })),
      installPlugin: vi.fn(async () => ({ installed: false, skipped: "claude CLI not found" })),
      startDaemon: vi.fn(async () => ({ started: false, alreadyRunning: true })),
    });

    const result = await runOnboard("/repo", { yes: true }, deps);

    expect(result.built).toBe(false);
    expect(result.plugin).toBe("claude CLI not found");
    expect(result.daemon).toBe("already running");
  });

  it("logs a plan line before doing anything", async () => {
    const log = vi.fn();
    const deps = makeDeps({ log });
    const opts: OnboardOptions = { yes: true, brain: "/b" };
    await runOnboard("/repo", opts, deps);

    const planLine = log.mock.calls.map((c) => c[0] as string).find((m) => m.startsWith("Will:"));
    expect(planLine).toBeDefined();
    expect(planLine).toContain("/b");
  });

  it("plan and done summary mention installing the Commonwealth plugin", async () => {
    const log = vi.fn();
    const deps = makeDeps({ log });
    await runOnboard("/repo", { yes: true }, deps);

    const lines = log.mock.calls.map((c) => c[0] as string);
    const planLine = lines.find((m) => m.startsWith("Will:"));
    expect(planLine).toContain("install the Commonwealth plugin");
    const doneLine = lines.find((m) => m.startsWith("Done."));
    expect(doneLine).toContain("plugin=installed");
  });
});

describe("parseAgentTarget", () => {
  it("defaults to Claude and accepts every public target", () => {
    expect(parseAgentTarget(undefined)).toBe("claude");
    expect(parseAgentTarget("claude")).toBe("claude");
    expect(parseAgentTarget("codex")).toBe("codex");
    expect(parseAgentTarget("both")).toBe("both");
  });

  it("rejects unknown targets", () => {
    expect(parseAgentTarget("cursor")).toBeNull();
    expect(parseAgentTarget("")).toBeNull();
  });
});
