import { describe, expect, it, vi } from "vitest";
import type { InitResult } from "../src/init.js";
import { runOnboard, type OnboardDeps, type OnboardOptions } from "../src/onboard.js";

const INIT_RESULT: InitResult = { mode: "new", brainDir: "/b", staged: 4, gathered: 4 };

/** Build injectable onboard deps with vitest spies; override any piece per test. */
function makeDeps(over: Partial<OnboardDeps> = {}): OnboardDeps {
  return {
    ensureBuilt: vi.fn(async () => ({ built: true })),
    init: vi.fn(async () => INIT_RESULT),
    configureScope: vi.fn(async () => ({ added: true })),
    setAutoAdr: vi.fn(async () => ({ set: true })),
    setRemote: vi.fn(async () => ({ set: true })),
    registerMcp: vi.fn(async () => ({ registered: true })),
    startDaemon: vi.fn(async () => ({ started: true })),
    confirm: vi.fn(async () => true),
    log: vi.fn(),
    ...over,
  };
}

describe("runOnboard", () => {
  it("full run (defaults): builds, inits, registers MCP, starts daemon, aggregates", async () => {
    const deps = makeDeps();
    const result = await runOnboard("/repo", { yes: true }, deps);

    expect(deps.ensureBuilt).toHaveBeenCalledTimes(1);
    expect(deps.init).toHaveBeenCalledTimes(1);
    expect(deps.configureScope).toHaveBeenCalledTimes(1);
    expect(deps.registerMcp).toHaveBeenCalledWith("/b");
    expect(deps.startDaemon).toHaveBeenCalledWith("/b");

    expect(result).toEqual({
      brainDir: "/b",
      mode: "new",
      built: true,
      staged: 4,
      scope: "added",
      autoAdr: "skipped",
      remote: "skipped",
      mcp: "registered",
      daemon: "started",
    });
  });

  it("--yes: never calls confirm; all steps run", async () => {
    const deps = makeDeps();
    await runOnboard("/repo", { yes: true }, deps);

    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.ensureBuilt).toHaveBeenCalledTimes(1);
    expect(deps.init).toHaveBeenCalledTimes(1);
    expect(deps.registerMcp).toHaveBeenCalledTimes(1);
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
    expect(deps.registerMcp).not.toHaveBeenCalled();
    expect(deps.startDaemon).not.toHaveBeenCalled();

    expect(result.mode).toBe("skipped");
    expect(result.built).toBe(false);
    expect(result.mcp).toBe("skipped");
    expect(result.daemon).toBe("skipped");
  });

  it("--no-build: skips ensureBuilt, runs the rest", async () => {
    const deps = makeDeps();
    const result = await runOnboard("/repo", { yes: true, build: false }, deps);

    expect(deps.ensureBuilt).not.toHaveBeenCalled();
    expect(deps.init).toHaveBeenCalledTimes(1);
    expect(deps.registerMcp).toHaveBeenCalledTimes(1);
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

  it("--no-mcp: skips registerMcp, runs the rest", async () => {
    const deps = makeDeps();
    const result = await runOnboard("/repo", { yes: true, mcp: false }, deps);

    expect(deps.registerMcp).not.toHaveBeenCalled();
    expect(deps.init).toHaveBeenCalledTimes(1);
    expect(deps.startDaemon).toHaveBeenCalledTimes(1);
    expect(result.mcp).toBe("skipped");
  });

  it("--no-daemon: skips startDaemon, runs the rest", async () => {
    const deps = makeDeps();
    const result = await runOnboard("/repo", { yes: true, daemon: false }, deps);

    expect(deps.startDaemon).not.toHaveBeenCalled();
    expect(deps.registerMcp).toHaveBeenCalledTimes(1);
    expect(result.daemon).toBe("skipped");
  });

  it("runs steps in order: ensureBuilt -> init -> scope -> autoAdr -> remote -> mcp -> daemon", async () => {
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
      registerMcp: vi.fn(async () => {
        calls.push("mcp");
        return { registered: true };
      }),
      startDaemon: vi.fn(async () => {
        calls.push("daemon");
        return { started: true };
      }),
    });

    await runOnboard("/repo", { yes: true, autoAdr: true, remote: "git@x:y.git" }, deps);
    expect(calls).toEqual(["build", "init", "scope", "autoAdr", "remote", "mcp", "daemon"]);
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
    expect(result.scope).toBe("added");
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

  it("scope idempotency: an already-added scope surfaces its skipped note", async () => {
    const deps = makeDeps({
      configureScope: vi.fn(async () => ({ added: false, skipped: "already allowed" })),
      setRemote: vi.fn(async () => ({ set: false, skipped: "origin exists" })),
    });
    const result = await runOnboard("/repo", { yes: true, remote: "git@x:y.git" }, deps);

    expect(result.scope).toBe("already allowed");
    expect(result.remote).toBe("origin exists");
  });

  it("decline (confirm=false): none of the new deps are called either", async () => {
    const deps = makeDeps({ confirm: vi.fn(async () => false) });
    await runOnboard("/repo", { brain: "/b", autoAdr: true, remote: "git@x:y.git" }, deps);

    expect(deps.configureScope).not.toHaveBeenCalled();
    expect(deps.setAutoAdr).not.toHaveBeenCalled();
    expect(deps.setRemote).not.toHaveBeenCalled();
  });

  it("idempotency surfaced: already-registered MCP + already-running daemon reflected without error", async () => {
    const deps = makeDeps({
      ensureBuilt: vi.fn(async () => ({ built: false })),
      registerMcp: vi.fn(async () => ({ registered: false, skipped: "already registered" })),
      startDaemon: vi.fn(async () => ({ started: false, alreadyRunning: true })),
    });

    const result = await runOnboard("/repo", { yes: true }, deps);

    expect(result.built).toBe(false);
    expect(result.mcp).toBe("already registered");
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
});
