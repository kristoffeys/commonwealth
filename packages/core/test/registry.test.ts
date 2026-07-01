import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveBrainDir, setBrainMarker } from "../src/registry";

let root: string;

beforeEach(async () => {
  // A real temp dir so walk-up / stat see actual files. realpath so macOS /var vs
  // /private/var symlinks don't break path-prefix comparisons.
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "commons-registry-")));
});

afterEach(async () => {
  delete process.env.COMMONS_REGISTRY;
  delete process.env.COMMONS_CONFIG;
  delete process.env.COMMONS_BRAIN_DIR;
  await fs.rm(root, { recursive: true, force: true });
});

/** Make a directory (recursively) under the temp root and return its absolute path. */
async function mkdir(...segments: string[]): Promise<string> {
  const dir = path.join(root, ...segments);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Turn `dir` into a brain by writing `.commons/config.json`. */
async function makeBrain(dir: string): Promise<string> {
  await fs.mkdir(path.join(dir, ".commons"), { recursive: true });
  await fs.writeFile(path.join(dir, ".commons", "config.json"), "{}\n", "utf8");
  return dir;
}

describe("resolveBrainDir", () => {
  it("reads a .commons/brain marker file, walking up and expanding relative to the marker", async () => {
    const project = await mkdir("proj");
    const nested = await mkdir("proj", "src", "deep");
    const brain = await makeBrain(await mkdir("acme-brain"));
    // Relative marker resolves against the dir that holds it.
    await setBrainMarker(project, path.relative(project, brain));

    // Force env/registry to something else to prove the marker wins.
    process.env.COMMONS_BRAIN_DIR = "/should/not/be/used";
    expect(await resolveBrainDir(nested)).toBe(brain);
  });

  it("resolves a directory that is itself a brain (self-is-brain)", async () => {
    const brain = await makeBrain(await mkdir("self-brain"));
    const inside = await mkdir("self-brain", "decisions");
    expect(await resolveBrainDir(inside)).toBe(brain);
    expect(await resolveBrainDir(brain)).toBe(brain);
  });

  it("prefers a marker over self-is-brain when both are present", async () => {
    const brain = await makeBrain(await mkdir("marked-brain"));
    const other = await makeBrain(await mkdir("target-brain"));
    await setBrainMarker(brain, other);
    // The dir is a brain, but its marker points elsewhere → marker (step 1) wins.
    expect(await resolveBrainDir(brain)).toBe(other);
  });

  it("maps via the user registry file, honoring $COMMONS_REGISTRY", async () => {
    const registryPath = path.join(root, "registry.json");
    const brain = await makeBrain(await mkdir("mapped-brain"));
    const workRoot = await mkdir("work");
    const cwd = await mkdir("work", "clientX", "app");
    await fs.writeFile(
      registryPath,
      JSON.stringify({ mappings: [{ prefix: workRoot, brain }] }),
      "utf8",
    );
    process.env.COMMONS_REGISTRY = registryPath;
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
    process.env.COMMONS_REGISTRY = registryPath;
    const underHome = path.join(os.homedir(), "some", "project");
    expect(await resolveBrainDir(underHome, { registryPath })).toBe(brain);
  });

  it("falls back to the env brain dir when nothing else matches", async () => {
    const brain = path.join(root, "env-brain");
    const cwd = await mkdir("loose", "project");
    expect(await resolveBrainDir(cwd, { env: brain })).toBe(brain);
    // Also via process.env.
    process.env.COMMONS_BRAIN_DIR = brain;
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

  it("honors a registry.json sibling of $COMMONS_CONFIG", async () => {
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
    process.env.COMMONS_CONFIG = path.join(configDir, "config.json");
    expect(await resolveBrainDir(cwd)).toBe(brain);
  });
});
