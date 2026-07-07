import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addRule,
  linkBrain,
  resolveBrainDir,
  resolveBrainMapping,
  setBrainMarker,
} from "../src/registry";

// Resolution + writer plumbing for the unified ruleset (ADR-0024). Rule *precedence* (repo/org/
// path/deny/default, longest-prefix, deny-on-tie) is covered in rule-resolution.test.ts; this file
// covers the other resolution layers (marker, self-is-brain, env), the file I/O (addRule format,
// corrupt-file safety, clone-on-demand remote), and linkBrain.

let root: string;

beforeEach(async () => {
  // A real temp dir so walk-up / stat see actual files. realpath so macOS /var vs
  // /private/var symlinks don't break path-prefix comparisons.
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-registry-")));
});

afterEach(async () => {
  delete process.env.COMMONWEALTH_REGISTRY;
  delete process.env.COMMONWEALTH_CONFIG;
  delete process.env.COMMONWEALTH_BRAIN_DIR;
  await fs.rm(root, { recursive: true, force: true });
});

/** Make a directory (recursively) under the temp root and return its absolute path. */
async function mkdir(...segments: string[]): Promise<string> {
  const dir = path.join(root, ...segments);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Turn `dir` into a brain by writing the brain-identity file `.commonwealth/schema-version`. */
async function makeBrain(dir: string): Promise<string> {
  await fs.mkdir(path.join(dir, ".commonwealth"), { recursive: true });
  await fs.writeFile(path.join(dir, ".commonwealth", "schema-version"), "1\n", "utf8");
  return dir;
}

describe("resolveBrainDir — non-rule layers (marker, self-is-brain, env)", () => {
  it("reads a .commonwealth/brain marker file, walking up and expanding relative to the marker", async () => {
    const project = await mkdir("proj");
    const nested = await mkdir("proj", "src", "deep");
    const brain = await makeBrain(await mkdir("acme-brain"));
    // Relative marker resolves against the dir that holds it.
    await setBrainMarker(project, path.relative(project, brain));

    // Force env/registry to something else to prove the marker wins.
    process.env.COMMONWEALTH_BRAIN_DIR = "/should/not/be/used";
    expect(await resolveBrainDir(nested)).toBe(brain);
  });

  it("skips a dangling marker (missing target) and falls through to a rule (#68)", async () => {
    const project = await mkdir("proj");
    const registryPath = path.join(root, "config.json");
    const realBrain = await makeBrain(await mkdir("real-brain"));
    await setBrainMarker(project, path.join(root, "ghost-brain")); // dangling
    await addRule({ prefix: project, brain: realBrain }, { registryPath }); // a rule that resolves

    // The dead marker must not hijack resolution — the rule wins.
    expect(await resolveBrainDir(project, { registryPath })).toBe(realBrain);
  });

  it("prefers a valid ancestor marker over a nearer dangling one (#68)", async () => {
    const parent = await mkdir("parent");
    const child = await mkdir("parent", "child");
    const brain = await makeBrain(await mkdir("ancestor-brain"));
    await setBrainMarker(parent, brain); // valid, higher up
    await setBrainMarker(child, path.join(root, "gone")); // dangling, nearer

    // Nearer marker is dead → keep walking up → the valid ancestor marker resolves.
    expect(await resolveBrainDir(child)).toBe(brain);
  });

  it("resolves a directory that is itself a brain (self-is-brain)", async () => {
    const brain = await makeBrain(await mkdir("self-brain"));
    const inside = await mkdir("self-brain", "decisions");
    expect(await resolveBrainDir(inside)).toBe(brain);
    expect(await resolveBrainDir(brain)).toBe(brain);
  });

  it("does NOT treat a dir with only `.commonwealth/config.json` (scope config) as a brain", async () => {
    // Regression: the per-user config lives at `~/.commonwealth/config.json`; a dir that merely
    // has that file (no schema-version) must not resolve as a brain, or the home dir would shadow
    // resolution. A rule must still win.
    const pseudo = await mkdir("has-scope-config");
    await fs.mkdir(path.join(pseudo, ".commonwealth"), { recursive: true });
    await fs.writeFile(
      path.join(pseudo, ".commonwealth", "config.json"),
      JSON.stringify({ allow: [], deny: [] }),
      "utf8",
    );
    const registryPath = path.join(root, "config.json");
    const brain = await makeBrain(await mkdir("real-brain"));
    await addRule({ prefix: pseudo, brain }, { registryPath });
    // Layer 2 skips `pseudo` (no schema-version) → the rule resolves the real brain.
    expect(await resolveBrainDir(pseudo, { registryPath })).toBe(brain);
  });

  it("prefers a marker over self-is-brain when both are present", async () => {
    const brain = await makeBrain(await mkdir("marked-brain"));
    const other = await makeBrain(await mkdir("target-brain"));
    await setBrainMarker(brain, other);
    // The dir is a brain, but its marker points elsewhere → marker (step 1) wins.
    expect(await resolveBrainDir(brain)).toBe(other);
  });

  it("reads rules from the config file named by $COMMONWEALTH_REGISTRY", async () => {
    const registryPath = path.join(root, "config.json");
    const brain = await makeBrain(await mkdir("mapped-brain"));
    const workRoot = await mkdir("work");
    const cwd = await mkdir("work", "clientX", "app");
    await fs.writeFile(
      registryPath,
      JSON.stringify({ rules: [{ prefix: workRoot, brain }] }),
      "utf8",
    );
    process.env.COMMONWEALTH_REGISTRY = registryPath;
    expect(await resolveBrainDir(cwd)).toBe(brain);
  });

  it("reads the config file named by $COMMONWEALTH_CONFIG (the file itself)", async () => {
    const configPath = path.join(root, "cfg", "config.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const brain = await makeBrain(await mkdir("cfg-brain"));
    const workRoot = await mkdir("cfgwork");
    const cwd = await mkdir("cfgwork", "app");
    await fs.writeFile(
      configPath,
      JSON.stringify({ rules: [{ prefix: workRoot, brain }] }),
      "utf8",
    );
    process.env.COMMONWEALTH_CONFIG = configPath;
    expect(await resolveBrainDir(cwd)).toBe(brain);
  });

  it("expands ~ in a rule's prefix and brain", async () => {
    const registryPath = path.join(root, "config.json");
    const brain = await makeBrain(await mkdir("home-brain"));
    await fs.writeFile(registryPath, JSON.stringify({ rules: [{ prefix: "~", brain }] }), "utf8");
    const underHome = path.join(os.homedir(), "some", "project");
    expect(await resolveBrainDir(underHome, { registryPath })).toBe(brain);
  });

  it("falls back to the env brain dir when nothing else matches", async () => {
    const brain = path.join(root, "env-brain");
    const cwd = await mkdir("loose", "project");
    expect(await resolveBrainDir(cwd, { env: brain })).toBe(brain);
    process.env.COMMONWEALTH_BRAIN_DIR = brain;
    expect(await resolveBrainDir(cwd)).toBe(brain);
  });

  it("returns null when no marker, brain, rule, or env is present", async () => {
    const cwd = await mkdir("orphan", "project");
    expect(await resolveBrainDir(cwd)).toBeNull();
  });

  it("a marker (layer 1) wins over a rule (layer 3)", async () => {
    const registryPath = path.join(root, "config.json");
    const markerBrain = await makeBrain(await mkdir("marker-brain"));
    const ruleBrain = await makeBrain(await mkdir("rule-brain"));
    const prefix = await mkdir("pw");
    const cwd = await mkdir("pw", "app");
    await addRule({ prefix, brain: ruleBrain }, { registryPath });
    await setBrainMarker(cwd, markerBrain);
    expect(await resolveBrainDir(cwd, { registryPath })).toBe(markerBrain);
  });
});

describe("addRule — file format & idempotence", () => {
  it("writes a new rule as valid, absolute JSON under `rules`", async () => {
    const registryPath = path.join(root, "sub", "config.json");
    const brain = await makeBrain(await mkdir("m-brain"));
    const prefix = await mkdir("m-work");

    const res = await addRule({ prefix, brain }, { registryPath });
    expect(res).toEqual({ added: true, updated: false });

    const parsed = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      rules: { prefix: string; brain: string }[];
    };
    expect(parsed.rules).toEqual([{ prefix, brain }]);
    expect(path.isAbsolute(parsed.rules[0].prefix)).toBe(true);
    expect(path.isAbsolute(parsed.rules[0].brain)).toBe(true);
  });

  it("is a no-op when the same rule is added again", async () => {
    const registryPath = path.join(root, "config.json");
    const brain = await makeBrain(await mkdir("m-brain"));
    const prefix = await mkdir("m-work");

    await addRule({ prefix, brain }, { registryPath });
    expect(await addRule({ prefix, brain }, { registryPath })).toEqual({
      added: false,
      updated: false,
    });
    const parsed = JSON.parse(await fs.readFile(registryPath, "utf8")) as { rules: unknown[] };
    expect(parsed.rules).toHaveLength(1);
  });

  it("updates the brain in place when the same matcher routes somewhere new", async () => {
    const registryPath = path.join(root, "config.json");
    const brainA = await makeBrain(await mkdir("brain-a"));
    const brainB = await makeBrain(await mkdir("brain-b"));
    const prefix = await mkdir("m-work");

    await addRule({ prefix, brain: brainA }, { registryPath });
    expect(await addRule({ prefix, brain: brainB }, { registryPath })).toEqual({
      added: false,
      updated: true,
    });
    const parsed = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      rules: { prefix: string; brain: string }[];
    };
    expect(parsed.rules).toEqual([{ prefix, brain: brainB }]);
  });

  it("round-trips: a cwd under a written prefix rule resolves via resolveBrainDir", async () => {
    const registryPath = path.join(root, "config.json");
    const brain = await makeBrain(await mkdir("rt-brain"));
    const prefix = await mkdir("rt-work");
    const cwd = await mkdir("rt-work", "client", "app");
    await addRule({ prefix, brain }, { registryPath });
    expect(await resolveBrainDir(cwd, { registryPath })).toBe(brain);
  });
});

describe("addRule — corrupt-file safety (#78)", () => {
  it("refuses to clobber a corrupt config, backs it up, and preserves the original", async () => {
    const registryPath = path.join(root, "config.json");
    const corrupt = '{ "rules": [ { "prefix": "/a", "brain": "/b" }';
    await fs.writeFile(registryPath, corrupt, "utf8");

    await expect(
      addRule({ prefix: "/new", brain: "/new-brain" }, { registryPath }),
    ).rejects.toThrow(/corrupt/);

    const files = await fs.readdir(root);
    const backup = files.find((f) => f.startsWith("config.json.corrupt-"));
    expect(backup).toBeTruthy();
    expect(await fs.readFile(path.join(root, backup!), "utf8")).toBe(corrupt);
  });

  it("treats a missing config as empty and creates it (normal first run)", async () => {
    const registryPath = path.join(root, "sub", "config.json");
    const res = await addRule({ prefix: "/proj", brain: "/brain" }, { registryPath });
    expect(res.added).toBe(true);
    const written = JSON.parse(await fs.readFile(registryPath, "utf8"));
    expect(written.rules).toHaveLength(1);
  });

  it("preserves existing rules when adding a new one", async () => {
    const registryPath = path.join(root, "config.json");
    await addRule({ prefix: "/one", brain: "/brain-one" }, { registryPath });
    await addRule({ prefix: "/two", brain: "/brain-two" }, { registryPath });
    const written = JSON.parse(await fs.readFile(registryPath, "utf8"));
    expect(written.rules).toHaveLength(2);
  });

  it("preserves unrelated keys (scope allow/deny) sharing the same config.json (ADR-0024 §6)", async () => {
    // core (rules) and curate (scope allow/deny) write the SAME file — neither may clobber the other.
    const registryPath = path.join(root, "config.json");
    await fs.writeFile(
      registryPath,
      JSON.stringify({ allow: ["/work"], deny: ["/work/secret"] }),
      "utf8",
    );
    await addRule({ prefix: "/work", brain: "/brain" }, { registryPath });
    const written = JSON.parse(await fs.readFile(registryPath, "utf8"));
    expect(written.allow).toEqual(["/work"]); // scope keys survive the rule write
    expect(written.deny).toEqual(["/work/secret"]);
    expect(written.rules).toHaveLength(1);
  });
});

describe("rule remote — clone-on-demand wiring (ADR-0019)", () => {
  it("round-trips a remote through addRule + resolveBrainMapping", async () => {
    const registryPath = path.join(root, "config.json");
    const project = await mkdir("proj");
    const brain = await mkdir("brain");
    await addRule(
      { prefix: project, brain, remote: "git@example.com:org/brain.git" },
      { registryPath },
    );

    const m = await resolveBrainMapping(project, { registryPath });
    expect(m?.brain).toBe(brain);
    expect(m?.remote).toBe("git@example.com:org/brain.git");
    expect(await resolveBrainDir(project, { registryPath })).toBe(brain);
  });

  it("updates the remote on an existing rule", async () => {
    const registryPath = path.join(root, "config.json");
    const project = await mkdir("proj");
    const brain = await mkdir("brain");
    await addRule({ prefix: project, brain }, { registryPath });
    const res = await addRule(
      { prefix: project, brain, remote: "https://example.com/y.git" },
      { registryPath },
    );
    expect(res.updated).toBe(true);
    expect((await resolveBrainMapping(project, { registryPath }))?.remote).toBe(
      "https://example.com/y.git",
    );
  });
});

describe("linkBrain", () => {
  it("creates a symlink pointing at the brain, idempotently", async () => {
    const brainsDir = path.join(root, "brains");
    const brain = await makeBrain(await mkdir("link-brain"));

    const first = await linkBrain("link-brain", brain, brainsDir);
    expect(first.linked).toBe(true);
    expect(await fs.realpath(first.path)).toBe(await fs.realpath(brain));

    const second = await linkBrain("link-brain", brain, brainsDir);
    expect(second).toEqual({ path: first.path, linked: true });
  });

  it("replaces a symlink that points elsewhere", async () => {
    const brainsDir = path.join(root, "brains");
    const brainA = await makeBrain(await mkdir("la"));
    const brainB = await makeBrain(await mkdir("lb"));

    await linkBrain("x", brainA, brainsDir);
    const res = await linkBrain("x", brainB, brainsDir);
    expect(res.linked).toBe(true);
    expect(await fs.realpath(res.path)).toBe(await fs.realpath(brainB));
  });

  it("does not clobber a real (non-symlink) file/dir at the path", async () => {
    const brainsDir = path.join(root, "brains");
    await fs.mkdir(brainsDir, { recursive: true });
    const realFile = path.join(brainsDir, "taken");
    await fs.writeFile(realFile, "keep me\n", "utf8");
    const brain = await makeBrain(await mkdir("k-brain"));

    const res = await linkBrain("taken", brain, brainsDir);
    expect(res.linked).toBe(false);
    expect(res.skipped).toBe("exists (not a symlink)");
    expect(await fs.readFile(realFile, "utf8")).toBe("keep me\n");
    const stat = await fs.lstat(realFile);
    expect(stat.isSymbolicLink()).toBe(false);
  });

  it("rejects an invalid name without throwing", async () => {
    const brainsDir = path.join(root, "brains");
    const brain = await makeBrain(await mkdir("i-brain"));
    expect(await linkBrain("..", brain, brainsDir)).toEqual({
      path: "",
      linked: false,
      skipped: "invalid name",
    });
  });

  it("returns skipped (never throws) when the brains dir cannot be created", async () => {
    const parentFile = path.join(root, "not-a-dir");
    await fs.writeFile(parentFile, "x\n", "utf8");
    const brainsDir = path.join(parentFile, "brains");
    const brain = await makeBrain(await mkdir("guard-brain"));
    const res = await linkBrain("guard", brain, brainsDir);
    expect(res.linked).toBe(false);
    expect(res.skipped).toBeTruthy();
  });
});
