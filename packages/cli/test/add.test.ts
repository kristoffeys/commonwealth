import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initBrain } from "@cmnwlth/core";
import { defaultAddDeps, runAdd, type AddDeps } from "../src/add.js";

/** Build fake {@link AddDeps} that record calls; override per test. */
function fakeDeps(overrides: Partial<AddDeps> = {}): {
  deps: AddDeps;
  calls: {
    allowed: string[];
    registered: Array<{ folder: string; brainDir: string; remote?: string }>;
    logs: string[];
  };
} {
  const calls = {
    allowed: [] as string[],
    registered: [] as Array<{ folder: string; brainDir: string; remote?: string }>,
    logs: [] as string[],
  };
  const deps: AddDeps = {
    resolveBrain: async () => ({ brain: "/brains/team", remote: "git@example:team.git" }),
    isDir: async () => true,
    isBrain: async () => true,
    allow: async (folder) => {
      calls.allowed.push(folder);
    },
    registerBrain: async (folder, brainDir, remote) => {
      calls.registered.push({ folder, brainDir, ...(remote !== undefined ? { remote } : {}) });
      return { added: true, updated: false, linked: true };
    },
    log: (m) => calls.logs.push(m),
    ...overrides,
  };
  return { deps, calls };
}

describe("runAdd", () => {
  it("wires every folder through allowlist + registry against the resolved brain", async () => {
    const { deps, calls } = fakeDeps();
    const code = await runAdd({ folders: ["/work/app", "/work/lib"], cwd: "/work" }, deps);

    expect(code).toBe(0);
    expect(calls.allowed).toEqual(["/work/app", "/work/lib"]);
    // The resolved mapping's clone-on-demand remote (ADR-0019) is carried onto new mappings.
    expect(calls.registered).toEqual([
      { folder: "/work/app", brainDir: "/brains/team", remote: "git@example:team.git" },
      { folder: "/work/lib", brainDir: "/brains/team", remote: "git@example:team.git" },
    ]);
  });

  it("defaults to the invocation dir when no folders are given", async () => {
    const { deps, calls } = fakeDeps();
    const code = await runAdd({ folders: [], cwd: "/work/app" }, deps);

    expect(code).toBe(0);
    expect(calls.allowed).toEqual(["/work/app"]);
  });

  it("expands a tilde in folder and brain arguments", async () => {
    const home = os.homedir();
    const { deps, calls } = fakeDeps();
    const code = await runAdd({ folders: ["~/proj"], brain: "~/brain", cwd: "/work" }, deps);

    expect(code).toBe(0);
    expect(calls.allowed).toEqual([path.join(home, "proj")]);
    expect(calls.registered[0]?.brainDir).toBe(path.join(home, "brain"));
  });

  it("--brain overrides resolution and carries no mapping remote", async () => {
    const { deps, calls } = fakeDeps({
      resolveBrain: async () => {
        throw new Error("must not resolve when --brain is explicit");
      },
    });
    const code = await runAdd({ folders: ["/work/app"], brain: "/brains/other", cwd: "/w" }, deps);

    expect(code).toBe(0);
    expect(calls.registered).toEqual([{ folder: "/work/app", brainDir: "/brains/other" }]);
  });

  it("--remote overrides the resolved mapping's remote", async () => {
    const { deps, calls } = fakeDeps();
    const code = await runAdd(
      { folders: ["/work/app"], remote: "git@example:override.git", cwd: "/work" },
      deps,
    );

    expect(code).toBe(0);
    expect(calls.registered[0]?.remote).toBe("git@example:override.git");
  });

  it("exits 2 and wires nothing when any folder is not a directory", async () => {
    const { deps, calls } = fakeDeps({ isDir: async (p) => p !== "/work/typo" });
    const code = await runAdd({ folders: ["/work/app", "/work/typo"], cwd: "/work" }, deps);

    expect(code).toBe(2);
    expect(calls.allowed).toEqual([]);
    expect(calls.registered).toEqual([]);
    expect(calls.logs.join("\n")).toContain("/work/typo");
  });

  it("exits 2 with guidance when no brain resolves and no --brain is given", async () => {
    const { deps, calls } = fakeDeps({ resolveBrain: async () => null });
    const code = await runAdd({ folders: ["/work/app"], cwd: "/work" }, deps);

    expect(code).toBe(2);
    expect(calls.registered).toEqual([]);
    expect(calls.logs.join("\n")).toContain("--brain");
  });

  it("exits 2 when the target is not a brain", async () => {
    const { deps, calls } = fakeDeps({ isBrain: async () => false });
    const code = await runAdd({ folders: ["/work/app"], brain: "/not/a/brain", cwd: "/w" }, deps);

    expect(code).toBe(2);
    expect(calls.allowed).toEqual([]);
    expect(calls.logs.join("\n")).toContain("commonwealth init");
  });

  it("exits 1 when a mapping write fails, still wiring the other folders", async () => {
    const { deps, calls } = fakeDeps({
      registerBrain: async (folder) =>
        folder === "/work/bad"
          ? { added: false, updated: false, linked: false, mapFailed: "registry corrupt" }
          : { added: true, updated: false, linked: true },
    });
    const code = await runAdd({ folders: ["/work/bad", "/work/app"], cwd: "/work" }, deps);

    expect(code).toBe(1);
    expect(calls.logs.join("\n")).toContain("FAILED to map /work/bad");
    expect(calls.logs.join("\n")).toContain("1/2 folder(s) wired");
  });

  it("reports a redirect of an existing mapping as 'remapped', never silently", async () => {
    const { deps, calls } = fakeDeps({
      registerBrain: async () => ({ added: false, updated: true, linked: true }),
    });
    const code = await runAdd({ folders: ["/work/app"], cwd: "/work" }, deps);

    expect(code).toBe(0);
    expect(calls.logs.join("\n")).toContain("remapped /work/app");
  });
});

describe("defaultAddDeps (real IO)", () => {
  let root: string;
  let brain: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-add-")));
    brain = path.join(root, "brain");
    await initBrain(brain, { name: "team" });
    // Point every default at the sandbox; never touch the real ~/.commonwealth.
    process.env.COMMONWEALTH_CONFIG = path.join(root, "config.json");
    process.env.COMMONWEALTH_REGISTRY = path.join(root, "registry.json");
    delete process.env.COMMONWEALTH_BRAIN_DIR;
  });

  afterEach(async () => {
    delete process.env.COMMONWEALTH_CONFIG;
    delete process.env.COMMONWEALTH_REGISTRY;
    await fs.rm(root, { recursive: true, force: true });
  });

  it("wires a folder end-to-end: allowlist entry, registry mapping, brains/ symlink", async () => {
    const project = path.join(root, "work", "app");
    await fs.mkdir(project, { recursive: true });

    const code = await runAdd({ folders: [project], brain, cwd: root }, defaultAddDeps());
    expect(code).toBe(0);

    const config = JSON.parse(await fs.readFile(path.join(root, "config.json"), "utf8")) as {
      allow: string[];
    };
    expect(config.allow).toContain(project);

    const registry = JSON.parse(await fs.readFile(path.join(root, "registry.json"), "utf8")) as {
      mappings: Array<{ prefix: string; brain: string }>;
    };
    expect(registry.mappings).toEqual([{ prefix: project, brain }]);

    // The convenience symlink lands next to the registry file.
    const link = path.join(root, "brains", "brain");
    expect(await fs.readlink(link)).toBe(brain);
  });

  it("resolves the brain (and remote) from the cwd's mapping when --brain is omitted", async () => {
    const first = path.join(root, "work", "app");
    const second = path.join(root, "work", "lib");
    await fs.mkdir(first, { recursive: true });
    await fs.mkdir(second, { recursive: true });

    const seed = await runAdd(
      { folders: [first], brain, remote: "git@example:team.git", cwd: root },
      defaultAddDeps(),
    );
    expect(seed).toBe(0);

    // From inside the mapped folder, wire a sibling with no --brain: same brain, same remote.
    const code = await runAdd({ folders: [second], cwd: first }, defaultAddDeps());
    expect(code).toBe(0);

    const registry = JSON.parse(await fs.readFile(path.join(root, "registry.json"), "utf8")) as {
      mappings: Array<{ prefix: string; brain: string; remote?: string }>;
    };
    expect(registry.mappings).toContainEqual({
      prefix: second,
      brain,
      remote: "git@example:team.git",
    });
  });

  it("refuses (exit 2) a --brain that is not a brain", async () => {
    const project = path.join(root, "proj");
    const notABrain = path.join(root, "plain");
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(notABrain, { recursive: true });

    const code = await runAdd(
      { folders: [project], brain: notABrain, cwd: root },
      defaultAddDeps(),
    );
    expect(code).toBe(2);
    // Nothing was wired: no registry file written.
    await expect(fs.stat(path.join(root, "registry.json"))).rejects.toThrow();
  });
});
