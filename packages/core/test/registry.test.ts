import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRegistryMapping, linkBrain, resolveBrainDir, setBrainMarker } from "../src/registry";

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

describe("resolveBrainDir", () => {
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

  it("skips a dangling marker (missing target) and falls through to the registry (#68)", async () => {
    const project = await mkdir("proj");
    const registryPath = path.join(root, "registry.json");
    const realBrain = await makeBrain(await mkdir("real-brain"));
    // A marker pointing at a brain that does not exist (moved/removed, or stale onboarding).
    await setBrainMarker(project, path.join(root, "ghost-brain"));
    // A registry mapping that DOES resolve.
    await addRegistryMapping(project, realBrain, registryPath);

    // The dead marker must not hijack resolution — the registry mapping wins.
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
    // Regression: the per-user scope config lives at `~/.commonwealth/config.json`; a dir
    // that merely has that file (no schema-version) must not resolve as a brain, or the home
    // dir would shadow the registry. A registry mapping must still win.
    const pseudo = await mkdir("has-scope-config");
    await fs.mkdir(path.join(pseudo, ".commonwealth"), { recursive: true });
    await fs.writeFile(
      path.join(pseudo, ".commonwealth", "config.json"),
      JSON.stringify({ allow: [], deny: [] }),
      "utf8",
    );
    const registryPath = path.join(root, "registry.json");
    const brain = await makeBrain(await mkdir("real-brain"));
    await addRegistryMapping(pseudo, brain, registryPath);
    // Layer 2 skips `pseudo` (no schema-version) → layer 3 registry resolves the real brain.
    expect(await resolveBrainDir(pseudo, { registryPath })).toBe(brain);
  });

  it("prefers a marker over self-is-brain when both are present", async () => {
    const brain = await makeBrain(await mkdir("marked-brain"));
    const other = await makeBrain(await mkdir("target-brain"));
    await setBrainMarker(brain, other);
    // The dir is a brain, but its marker points elsewhere → marker (step 1) wins.
    expect(await resolveBrainDir(brain)).toBe(other);
  });

  it("maps via the user registry file, honoring $COMMONWEALTH_REGISTRY", async () => {
    const registryPath = path.join(root, "registry.json");
    const brain = await makeBrain(await mkdir("mapped-brain"));
    const workRoot = await mkdir("work");
    const cwd = await mkdir("work", "clientX", "app");
    await fs.writeFile(
      registryPath,
      JSON.stringify({ mappings: [{ prefix: workRoot, brain }] }),
      "utf8",
    );
    process.env.COMMONWEALTH_REGISTRY = registryPath;
    expect(await resolveBrainDir(cwd)).toBe(brain);
  });

  it("expands ~ in registry prefix and brain", async () => {
    const registryPath = path.join(root, "registry.json");
    // Use the home dir itself as an in-scope prefix; brain can be anywhere.
    const brain = await makeBrain(await mkdir("home-brain"));
    await fs.writeFile(
      registryPath,
      JSON.stringify({ mappings: [{ prefix: "~", brain }] }),
      "utf8",
    );
    process.env.COMMONWEALTH_REGISTRY = registryPath;
    const underHome = path.join(os.homedir(), "some", "project");
    expect(await resolveBrainDir(underHome, { registryPath })).toBe(brain);
  });

  it("falls back to the env brain dir when nothing else matches", async () => {
    const brain = path.join(root, "env-brain");
    const cwd = await mkdir("loose", "project");
    expect(await resolveBrainDir(cwd, { env: brain })).toBe(brain);
    // Also via process.env.
    process.env.COMMONWEALTH_BRAIN_DIR = brain;
    expect(await resolveBrainDir(cwd)).toBe(brain);
  });

  it("returns null when no marker, brain, mapping, or env is present", async () => {
    const cwd = await mkdir("orphan", "project");
    expect(await resolveBrainDir(cwd)).toBeNull();
  });

  it("is prefix-boundary safe: /work does not match /workshop", async () => {
    const registryPath = path.join(root, "registry.json");
    const brain = await makeBrain(await mkdir("b"));
    const workRoot = await mkdir("work");
    const workshop = await mkdir("workshop", "proj");
    await fs.writeFile(
      registryPath,
      JSON.stringify({ mappings: [{ prefix: workRoot, brain }] }),
      "utf8",
    );
    // A sibling that merely shares a prefix string is not "under" the mapping prefix,
    // and (no marker/brain/env) resolves to null.
    expect(await resolveBrainDir(workshop, { registryPath })).toBeNull();
  });

  it("honors a registry.json sibling of $COMMONWEALTH_CONFIG", async () => {
    const configDir = await mkdir("cfg");
    const registryPath = path.join(configDir, "registry.json");
    const brain = await makeBrain(await mkdir("cfg-brain"));
    const workRoot = await mkdir("cfgwork");
    const cwd = await mkdir("cfgwork", "app");
    await fs.writeFile(
      registryPath,
      JSON.stringify({ mappings: [{ prefix: workRoot, brain }] }),
      "utf8",
    );
    process.env.COMMONWEALTH_CONFIG = path.join(configDir, "config.json");
    expect(await resolveBrainDir(cwd)).toBe(brain);
  });
});

describe("addRegistryMapping", () => {
  it("writes a new mapping as valid, absolute JSON", async () => {
    const registryPath = path.join(root, "sub", "registry.json");
    const brain = await makeBrain(await mkdir("m-brain"));
    const prefix = await mkdir("m-work");

    const res = await addRegistryMapping(prefix, brain, registryPath);
    expect(res).toEqual({ added: true, updated: false });

    const parsed = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      mappings: { prefix: string; brain: string }[];
    };
    expect(parsed.mappings).toEqual([{ prefix, brain }]);
    expect(path.isAbsolute(parsed.mappings[0].prefix)).toBe(true);
    expect(path.isAbsolute(parsed.mappings[0].brain)).toBe(true);
  });

  it("is a no-op when the same prefix+brain is added again", async () => {
    const registryPath = path.join(root, "registry.json");
    const brain = await makeBrain(await mkdir("m-brain"));
    const prefix = await mkdir("m-work");

    await addRegistryMapping(prefix, brain, registryPath);
    const second = await addRegistryMapping(prefix, brain, registryPath);
    expect(second).toEqual({ added: false, updated: false });

    const parsed = JSON.parse(await fs.readFile(registryPath, "utf8")) as { mappings: unknown[] };
    expect(parsed.mappings).toHaveLength(1);
  });

  it("updates the brain when the same prefix maps somewhere new", async () => {
    const registryPath = path.join(root, "registry.json");
    const brainA = await makeBrain(await mkdir("brain-a"));
    const brainB = await makeBrain(await mkdir("brain-b"));
    const prefix = await mkdir("m-work");

    await addRegistryMapping(prefix, brainA, registryPath);
    const res = await addRegistryMapping(prefix, brainB, registryPath);
    expect(res).toEqual({ added: false, updated: true });

    const parsed = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      mappings: { prefix: string; brain: string }[];
    };
    expect(parsed.mappings).toEqual([{ prefix, brain: brainB }]);
  });

  it("round-trips: a cwd under a written prefix resolves via resolveBrainDir", async () => {
    const registryPath = path.join(root, "registry.json");
    const brain = await makeBrain(await mkdir("rt-brain"));
    const prefix = await mkdir("rt-work");
    const cwd = await mkdir("rt-work", "client", "app");

    await addRegistryMapping(prefix, brain, registryPath);
    // No marker/self-brain shadows it; resolve strictly via the registry mapping.
    expect(await resolveBrainDir(cwd, { registryPath })).toBe(brain);
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
    // The real file is untouched.
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
    // A regular file sits where brainsDir's parent should be → mkdir throws ENOTDIR.
    const parentFile = path.join(root, "not-a-dir");
    await fs.writeFile(parentFile, "x\n", "utf8");
    const brainsDir = path.join(parentFile, "brains");
    const brain = await makeBrain(await mkdir("guard-brain"));
    const res = await linkBrain("guard", brain, brainsDir);
    expect(res.linked).toBe(false);
    expect(res.skipped).toBeTruthy();
  });
});

describe("addRegistryMapping — corrupt-file safety (#78)", () => {
  it("refuses to clobber a corrupt registry, backs it up, and preserves the original", async () => {
    const registryPath = path.join(root, "registry.json");
    // A partial/corrupt write: invalid JSON that still holds real wiring bytes.
    const corrupt = '{ "mappings": [ { "prefix": "/a", "brain": "/b" }';
    await fs.writeFile(registryPath, corrupt, "utf8");

    await expect(addRegistryMapping("/new", "/new-brain", registryPath)).rejects.toThrow(/corrupt/);

    // The corrupt file is not silently replaced with a one-entry registry.
    const files = await fs.readdir(root);
    const backup = files.find((f) => f.startsWith("registry.json.corrupt-"));
    expect(backup).toBeTruthy();
    // The original bytes survive (in the backup, since we rename it aside).
    expect(await fs.readFile(path.join(root, backup!), "utf8")).toBe(corrupt);
  });

  it("treats a missing registry as empty and creates it (normal first run)", async () => {
    const registryPath = path.join(root, "sub", "registry.json");
    const res = await addRegistryMapping("/proj", "/brain", registryPath);
    expect(res.added).toBe(true);
    const written = JSON.parse(await fs.readFile(registryPath, "utf8"));
    expect(written.mappings).toHaveLength(1);
  });

  it("preserves existing mappings when adding a new one", async () => {
    const registryPath = path.join(root, "registry.json");
    await addRegistryMapping("/one", "/brain-one", registryPath);
    await addRegistryMapping("/two", "/brain-two", registryPath);
    const written = JSON.parse(await fs.readFile(registryPath, "utf8"));
    expect(written.mappings).toHaveLength(2);
  });
});

describe("resolution precedence", () => {
  it("a marker (layer 1) wins over a registry mapping (layer 3)", async () => {
    const registryPath = path.join(root, "registry.json");
    const markerBrain = await makeBrain(await mkdir("marker-brain"));
    const registryBrain = await makeBrain(await mkdir("registry-brain"));
    const prefix = await mkdir("pw");
    const cwd = await mkdir("pw", "app");

    await addRegistryMapping(prefix, registryBrain, registryPath);
    await setBrainMarker(cwd, markerBrain);

    expect(await resolveBrainDir(cwd, { registryPath })).toBe(markerBrain);
  });
});
