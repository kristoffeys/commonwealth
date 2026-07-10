import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBrainConfig } from "../src/config";
import { initBrain } from "../src/scaffold";
import {
  addRule,
  addSharedRule,
  importAllSharedRules,
  importSharedRules,
  loadRegistryFile,
  removeSharedRule,
  resolveBrain,
} from "../src/registry";

// Shared-vs-local rule origin (ADR-0024 §5): shared rules live in a brain's committed config and
// sync to the team; `importSharedRules` materializes them into the per-user config as
// `origin: "shared"` rules; local rules override shared.

let root: string;
let registryPath: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-shared-")));
  registryPath = path.join(root, "config.json");
});

afterEach(async () => {
  delete process.env.COMMONWEALTH_BRAIN_DIR;
  await fs.rm(root, { recursive: true, force: true });
});

async function gitRepo(name: string, origin?: string): Promise<string> {
  const repo = path.join(root, name);
  await fs.mkdir(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  if (origin) execFileSync("git", ["-C", repo, "remote", "add", "origin", origin]);
  return repo;
}

describe("addSharedRule / removeSharedRule — the brain's committed sharedRules", () => {
  it("stores only the matcher (+deny), stripping brain/origin/remote, and dedupes by matcher", async () => {
    const brain = path.join(root, "brain");
    await initBrain(brain);

    // A route rule with extras: only the matcher survives into sharedRules.
    expect(
      await addSharedRule(brain, {
        org: "weareantenna/*",
        brain: "/local/only/path",
        remote: "git@x:o/b.git",
        origin: "local",
      }),
    ).toEqual({ added: true, updated: false });
    let cfg = await loadBrainConfig(brain);
    expect(cfg.sharedRules).toEqual([{ org: "weareantenna/*" }]);

    // A deny keeps its deny flag.
    await addSharedRule(brain, { repo: "weareantenna/secrets", deny: true });
    cfg = await loadBrainConfig(brain);
    expect(cfg.sharedRules).toContainEqual({ repo: "weareantenna/secrets", deny: true });
    expect(cfg.sharedRules).toHaveLength(2);

    // Same matcher, new outcome → update in place, not a duplicate.
    expect(await addSharedRule(brain, { repo: "weareantenna/secrets" })).toEqual({
      added: false,
      updated: true,
    });
    cfg = await loadBrainConfig(brain);
    expect(cfg.sharedRules.filter((r) => r.repo === "weareantenna/secrets")).toEqual([
      { repo: "weareantenna/secrets" },
    ]);

    // Remove by matcher.
    expect(await removeSharedRule(brain, { repo: "weareantenna/secrets" })).toEqual({ removed: 1 });
    cfg = await loadBrainConfig(brain);
    expect(cfg.sharedRules).toEqual([{ org: "weareantenna/*" }]);
  });
});

describe("importSharedRules — materialize into the per-user config, then resolve", () => {
  it("materializes a shared route (→ this brain) and a shared deny, and resolves both", async () => {
    const brain = path.join(root, "team-brain");
    await initBrain(brain);
    await addSharedRule(brain, { org: "weareantenna/*" });
    await addSharedRule(brain, { repo: "weareantenna/secrets", deny: true });

    const res = await importSharedRules(brain, { registryPath });
    expect(res).toEqual({ imported: 2, pruned: 0 });

    const reg = await loadRegistryFile({ registryPath });
    expect(reg?.rules).toContainEqual({
      org: "weareantenna/*",
      brain,
      origin: "shared",
      sharedFrom: brain,
    });
    expect(reg?.rules).toContainEqual({
      repo: "weareantenna/secrets",
      deny: true,
      origin: "shared",
      sharedFrom: brain,
    });

    // The shared route resolves this org to the brain; the shared deny denies the secret repo.
    const app = await gitRepo("app", "git@github.com:weareantenna/app.git");
    const secrets = await gitRepo("secrets", "git@github.com:weareantenna/secrets.git");
    expect(await resolveBrain(app, { registryPath })).toEqual({ kind: "brain", brain });
    expect(await resolveBrain(secrets, { registryPath })).toEqual({ kind: "denied" });
  });

  it("prunes a shared rule the brain has stopped sharing (re-import)", async () => {
    const brain = path.join(root, "brain");
    await initBrain(brain);
    await addSharedRule(brain, { org: "weareantenna/*" });
    await importSharedRules(brain, { registryPath });
    expect((await loadRegistryFile({ registryPath }))?.rules).toHaveLength(1);

    // Un-share upstream, then re-import → the per-user materialization is pruned.
    await removeSharedRule(brain, { org: "weareantenna/*" });
    const res = await importSharedRules(brain, { registryPath });
    expect(res).toEqual({ imported: 0, pruned: 1 });
    expect((await loadRegistryFile({ registryPath }))?.rules ?? []).toHaveLength(0);
  });

  it("local overrides shared: a local rule for the same matcher is not overwritten, and wins", async () => {
    const brain = path.join(root, "team-brain");
    const mine = path.join(root, "my-brain");
    await initBrain(brain);
    await addSharedRule(brain, { org: "weareantenna/*" }); // team: org → team-brain

    // I have a LOCAL rule for the same org pointing at my own brain.
    await addRule({ org: "weareantenna/*", brain: mine }, { registryPath });

    const res = await importSharedRules(brain, { registryPath });
    expect(res.imported).toBe(0); // shadowed by my local rule → not imported

    const app = await gitRepo("app", "git@github.com:weareantenna/app.git");
    expect(await resolveBrain(app, { registryPath })).toEqual({ kind: "brain", brain: mine });
  });

  it("does not prune when the brain config is missing (uncloned/unmounted brain)", async () => {
    const brain = path.join(root, "team-brain");
    await initBrain(brain);
    await addSharedRule(brain, { org: "weareantenna/*" });
    await importSharedRules(brain, { registryPath });
    expect((await loadRegistryFile({ registryPath }))?.rules).toHaveLength(1);

    // The brain vanishes (unmounted). Import must be a no-op, not a prune.
    await fs.rm(brain, { recursive: true, force: true });
    const res = await importSharedRules(brain, { registryPath });
    expect(res).toEqual({ imported: 0, pruned: 0 });
    expect((await loadRegistryFile({ registryPath }))?.rules).toHaveLength(1);
  });
});

describe("importAllSharedRules — every wired brain", () => {
  it("imports shared rules from each brain a rule routes to", async () => {
    const erp = path.join(root, "erp-brain");
    const web = path.join(root, "web-brain");
    await initBrain(erp);
    await initBrain(web);
    await addSharedRule(erp, { repo: "weareantenna/erp" });
    await addSharedRule(web, { repo: "weareantenna/web" });
    // Wire both brains into the per-user config so listWiredBrainDirs finds them.
    await addRule({ repo: "weareantenna/erp", brain: erp }, { registryPath });
    await addRule({ repo: "weareantenna/web", brain: web }, { registryPath });

    const res = await importAllSharedRules({ registryPath });
    // Each shared rule is shadowed by the local wiring rule for the SAME repo → 0 imported.
    expect(res.imported).toBe(0);

    // Now a shared rule with a DISTINCT matcher on erp-brain does import.
    await addSharedRule(erp, { org: "weareantenna/*" });
    const res2 = await importAllSharedRules({ registryPath });
    expect(res2.imported).toBe(1);
    const reg = await loadRegistryFile({ registryPath });
    expect(reg?.rules).toContainEqual({
      org: "weareantenna/*",
      brain: erp,
      origin: "shared",
      sharedFrom: erp,
    });
  });
});
