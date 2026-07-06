import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRegistryMapping, getOrgBrain, listWiredBrainDirs, setOrgBrain } from "../src/registry";

// Org-brain designation + brain enumeration (#167, ADR-0023). These back org-brain graduation
// (#110): listWiredBrainDirs supplies the project brains to scan; get/setOrgBrain locate the
// graduation target.

let root: string;

beforeEach(async () => {
  // realpath so macOS /var vs /private/var symlinks don't break path-prefix comparisons.
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-orgbrain-")));
});

afterEach(async () => {
  delete process.env.COMMONWEALTH_REGISTRY;
  delete process.env.COMMONWEALTH_CONFIG;
  await fs.rm(root, { recursive: true, force: true });
});

/** Write a raw registry file and return its path. */
async function writeRegistry(contents: unknown | string): Promise<string> {
  const registryPath = path.join(root, "registry.json");
  await fs.writeFile(
    registryPath,
    typeof contents === "string" ? contents : JSON.stringify(contents),
    "utf8",
  );
  return registryPath;
}

describe("listWiredBrainDirs", () => {
  it("returns wired brain dirs, deduped by absolute path", async () => {
    const registryPath = await writeRegistry({
      mappings: [
        { prefix: "/work/a", brain: "/brains/a" },
        { prefix: "/work/b", brain: "/brains/b" },
        // Same brain wired under a second prefix (two checkouts of one repo) → counted once.
        { prefix: "/work/a-clone", brain: "/brains/a" },
      ],
    });
    const dirs = await listWiredBrainDirs({ registryPath });
    expect(dirs).toEqual([path.resolve("/brains/a"), path.resolve("/brains/b")]);
  });

  it("excludes the designated org-brain from the project-brain list", async () => {
    const registryPath = await writeRegistry({
      mappings: [
        { prefix: "/work/a", brain: "/brains/a" },
        { prefix: "/work/org", brain: "/brains/org" },
      ],
      orgBrain: { brain: "/brains/org" },
    });
    const dirs = await listWiredBrainDirs({ registryPath });
    expect(dirs).toEqual([path.resolve("/brains/a")]);
  });

  it("returns [] on a missing registry without throwing", async () => {
    const dirs = await listWiredBrainDirs({ registryPath: path.join(root, "nope.json") });
    expect(dirs).toEqual([]);
  });

  it("returns [] on a corrupt registry without throwing", async () => {
    const registryPath = await writeRegistry("{ not json ]");
    await expect(listWiredBrainDirs({ registryPath })).resolves.toEqual([]);
  });
});

describe("get/setOrgBrain", () => {
  it("round-trips a designated org-brain, expanding to an absolute path", async () => {
    const registryPath = path.join(root, "registry.json");
    await setOrgBrain("/brains/org", { registryPath });
    const org = await getOrgBrain({ registryPath });
    expect(org).toEqual({ brain: path.resolve("/brains/org") });
  });

  it("carries a clone-on-demand remote through the round-trip", async () => {
    const registryPath = path.join(root, "registry.json");
    await setOrgBrain("/brains/org", {
      remote: "git@example.com:team/org-brain.git",
      registryPath,
    });
    const org = await getOrgBrain({ registryPath });
    expect(org).toEqual({
      brain: path.resolve("/brains/org"),
      remote: "git@example.com:team/org-brain.git",
    });
  });

  it("returns null when no org-brain is designated", async () => {
    const registryPath = await writeRegistry({
      mappings: [{ prefix: "/work", brain: "/brains/a" }],
    });
    expect(await getOrgBrain({ registryPath })).toBeNull();
  });

  it("preserves existing mappings when designating the org-brain", async () => {
    const registryPath = await writeRegistry({
      mappings: [{ prefix: "/work/a", brain: "/brains/a" }],
    });
    await setOrgBrain("/brains/org", { registryPath });
    const parsed = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      mappings: unknown[];
      orgBrain: { brain: string };
    };
    expect(parsed.mappings).toHaveLength(1);
    expect(parsed.orgBrain.brain).toBe(path.resolve("/brains/org"));
  });

  it("survives a later addRegistryMapping write (both writers share one file)", async () => {
    const registryPath = path.join(root, "registry.json");
    await setOrgBrain("/brains/org", { registryPath });
    await addRegistryMapping("/work/a", "/brains/a", { registryPath });
    const org = await getOrgBrain({ registryPath });
    expect(org?.brain).toBe(path.resolve("/brains/org"));
    expect(await listWiredBrainDirs({ registryPath })).toEqual([path.resolve("/brains/a")]);
  });

  it("refuses to clobber a corrupt registry, backing it up", async () => {
    const registryPath = await writeRegistry("{ corrupt ]");
    await expect(setOrgBrain("/brains/org", { registryPath })).rejects.toThrow(/corrupt/i);
    const siblings = await fs.readdir(root);
    expect(siblings.some((f) => f.startsWith("registry.json.corrupt-"))).toBe(true);
  });
});
