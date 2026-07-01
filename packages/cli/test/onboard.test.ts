import { describe, expect, it, vi } from "vitest";
import type { InitResult } from "../src/init.js";
import { runOnboard, type OnboardDeps, type OnboardOptions } from "../src/onboard.js";

const INIT_RESULT: InitResult = { mode: "new", brainDir: "/b", staged: 4, gathered: 4 };

/** Build injectable onboard deps with vitest spies; override any piece per test. */
function makeDeps(over: Partial<OnboardDeps> = {}): OnboardDeps {
  return {
    ensureBuilt: vi.fn(async () => ({ built: true })),
    init: vi.fn(async () => INIT_RESULT),
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
    expect(deps.registerMcp).toHaveBeenCalledWith("/b");
    expect(deps.startDaemon).toHaveBeenCalledWith("/b");

    expect(result).toEqual({
      brainDir: "/b",
      mode: "new",
      built: true,
      staged: 4,
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

  it("runs steps in order: ensureBuilt -> init -> registerMcp -> startDaemon", async () => {
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
      registerMcp: vi.fn(async () => {
        calls.push("mcp");
        return { registered: true };
      }),
      startDaemon: vi.fn(async () => {
        calls.push("daemon");
        return { started: true };
      }),
    });

    await runOnboard("/repo", { yes: true }, deps);
    expect(calls).toEqual(["build", "init", "mcp", "daemon"]);
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
