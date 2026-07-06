import { describe, expect, it } from "vitest";
import { parseOrgBrainArgs, runOrgBrain, type OrgBrainDeps } from "../src/index.js";

// `commonwealth org-brain` (#167, ADR-0023): designate/show the graduation target.

/** Build fake {@link OrgBrainDeps} that record calls; override per test. */
function fakeDeps(overrides: Partial<OrgBrainDeps> = {}): {
  deps: OrgBrainDeps;
  calls: { set: Array<{ brain: string; remote?: string }>; logs: string[]; out: string[] };
} {
  const calls = {
    set: [] as Array<{ brain: string; remote?: string }>,
    logs: [] as string[],
    out: [] as string[],
  };
  const deps: OrgBrainDeps = {
    isDir: async () => true,
    isBrain: async () => true,
    setOrgBrain: async (brain, remote) => {
      calls.set.push({ brain, ...(remote !== undefined ? { remote } : {}) });
    },
    getOrgBrain: async () => null,
    log: (m) => calls.logs.push(m),
    out: (m) => calls.out.push(m),
    ...overrides,
  };
  return { deps, calls };
}

describe("parseOrgBrainArgs", () => {
  it("parses `set <dir> --remote <url>`", () => {
    expect(parseOrgBrainArgs(["set", "/brains/org", "--remote", "git@x:o.git"])).toEqual({
      action: "set",
      dir: "/brains/org",
      remote: "git@x:o.git",
    });
  });

  it("parses `show`", () => {
    expect(parseOrgBrainArgs(["show"])).toEqual({ action: "show" });
  });

  it("rejects a missing dir, an unknown subcommand, and a dangling --remote", () => {
    expect(parseOrgBrainArgs(["set"])).toBeNull();
    expect(parseOrgBrainArgs(["frobnicate"])).toBeNull();
    expect(parseOrgBrainArgs(["set", "/a", "--remote"])).toBeNull();
    expect(parseOrgBrainArgs(["set", "/a", "/b"])).toBeNull();
  });
});

describe("runOrgBrain set", () => {
  it("designates an existing brain", async () => {
    const { deps, calls } = fakeDeps();
    const code = await runOrgBrain({ action: "set", dir: "/brains/org" }, deps);
    expect(code).toBe(0);
    expect(calls.set).toHaveLength(1);
    expect(calls.set[0].brain).toBe("/brains/org");
  });

  it("refuses a directory that is not a brain", async () => {
    const { deps, calls } = fakeDeps({ isBrain: async () => false });
    const code = await runOrgBrain({ action: "set", dir: "/tmp/not-a-brain" }, deps);
    expect(code).toBe(2);
    expect(calls.set).toHaveLength(0);
    expect(calls.logs.join("\n")).toMatch(/not a brain/);
  });

  it("refuses a missing dir with no --remote", async () => {
    const { deps, calls } = fakeDeps({ isDir: async () => false });
    const code = await runOrgBrain({ action: "set", dir: "/brains/gone" }, deps);
    expect(code).toBe(2);
    expect(calls.set).toHaveLength(0);
    expect(calls.logs.join("\n")).toMatch(/does not exist/);
  });

  it("records a clone-on-demand pointer for a missing dir WITH --remote", async () => {
    const { deps, calls } = fakeDeps({ isDir: async () => false });
    const code = await runOrgBrain(
      { action: "set", dir: "/brains/org", remote: "git@x:o.git" },
      deps,
    );
    expect(code).toBe(0);
    expect(calls.set[0]).toEqual({ brain: "/brains/org", remote: "git@x:o.git" });
    expect(calls.logs.join("\n")).toMatch(/clone on demand/);
  });

  it("returns 1 when the registry write fails", async () => {
    const { deps } = fakeDeps({
      setOrgBrain: async () => {
        throw new Error("corrupt registry");
      },
    });
    const code = await runOrgBrain({ action: "set", dir: "/brains/org" }, deps);
    expect(code).toBe(1);
  });
});

describe("runOrgBrain show", () => {
  it("prints the current pointer", async () => {
    const { deps, calls } = fakeDeps({
      getOrgBrain: async () => ({ brain: "/brains/org", remote: "git@x:o.git" }),
    });
    const code = await runOrgBrain({ action: "show" }, deps);
    expect(code).toBe(0);
    expect(calls.out.join("\n")).toContain("/brains/org");
    expect(calls.out.join("\n")).toContain("git@x:o.git");
  });

  it("says none when undesignated", async () => {
    const { deps, calls } = fakeDeps();
    const code = await runOrgBrain({ action: "show" }, deps);
    expect(code).toBe(0);
    expect(calls.out.join("\n")).toMatch(/none designated/);
  });
});
