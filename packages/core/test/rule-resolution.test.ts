import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addRule,
  loadRegistryFile,
  removeRule,
  resolveBrain,
  resolveBrainDir,
  resolveBrainMapping,
  type Rule,
  setDefaultBrain,
} from "../src/registry";

// Tests for the unified rule-based resolution (ADR-0024): match by git identity or path →
// brain / denied / none. Identity tests create real git repos (with a fake origin) so
// `resolveProjectSource` produces an `owner/repo` slug, exactly as it does in the field.

let root: string;
let registryPath: string;

beforeEach(async () => {
  // realpath so macOS /var vs /private/var symlinks don't break path-prefix comparisons.
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-rules-")));
  registryPath = path.join(root, "registry.json");
});

afterEach(async () => {
  delete process.env.COMMONWEALTH_BRAIN_DIR;
  await fs.rm(root, { recursive: true, force: true });
});

/** Write a registry file with the given rules / defaultBrain / legacy mappings. */
async function writeRegistry(reg: {
  rules?: Rule[];
  defaultBrain?: unknown;
  mappings?: unknown[];
}): Promise<void> {
  await fs.writeFile(registryPath, JSON.stringify(reg), "utf8");
}

async function mkdir(...segments: string[]): Promise<string> {
  const dir = path.join(root, ...segments);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Create a git repo under the temp root, optionally with an `origin` remote. */
async function gitRepo(name: string, origin?: string): Promise<string> {
  const repo = await mkdir(name);
  execFileSync("git", ["init", "-q", repo]);
  if (origin) execFileSync("git", ["-C", repo, "remote", "add", "origin", origin]);
  return repo;
}

/** An absolute brain path under the temp root (need not exist — rules don't stat the brain). */
function brainPath(name: string): string {
  return path.join(root, "brains", name);
}

describe("resolveBrain — identity matching (ADR-0024)", () => {
  it("matches an exact repo rule and routes to its brain", async () => {
    const repo = await gitRepo("erp", "git@github.com:weareantenna/erp.git");
    const erpBrain = brainPath("erp");
    await writeRegistry({ rules: [{ repo: "weareantenna/erp", brain: erpBrain }] });

    expect(await resolveBrain(repo, { registryPath })).toEqual({ kind: "brain", brain: erpBrain });
  });

  it("matches an org glob and routes a bare allow to the default brain", async () => {
    const repo = await gitRepo("foo", "git@github.com:weareantenna/foo.git");
    const antenna = brainPath("antenna");
    await writeRegistry({ rules: [{ org: "weareantenna/*" }], defaultBrain: antenna });

    expect(await resolveBrain(repo, { registryPath })).toEqual({ kind: "brain", brain: antenna });
  });

  it("most-specific wins: a repo brain overrides a broader org allow", async () => {
    const repo = await gitRepo("erp", "git@github.com:weareantenna/erp.git");
    const antenna = brainPath("antenna");
    const erpBrain = brainPath("erp");
    await writeRegistry({
      rules: [
        { org: "weareantenna/*", brain: antenna },
        { repo: "weareantenna/erp", brain: erpBrain },
      ],
    });

    expect(await resolveBrain(repo, { registryPath })).toEqual({ kind: "brain", brain: erpBrain });
  });

  it("a specific repo deny narrows a broad org allow", async () => {
    const secrets = await gitRepo("secrets", "git@github.com:weareantenna/secrets.git");
    const other = await gitRepo("other", "git@github.com:weareantenna/other.git");
    const antenna = brainPath("antenna");
    await writeRegistry({
      rules: [{ org: "weareantenna/*" }, { repo: "weareantenna/secrets", deny: true }],
      defaultBrain: antenna,
    });

    expect(await resolveBrain(secrets, { registryPath })).toEqual({ kind: "denied" });
    expect(await resolveBrain(other, { registryPath })).toEqual({ kind: "brain", brain: antenna });
  });

  it("a specific allow carves an exception out of a broad org deny", async () => {
    const pub = await gitRepo("public", "git@github.com:weareantenna/public.git");
    const priv = await gitRepo("private", "git@github.com:weareantenna/private.git");
    const pubBrain = brainPath("pub");
    await writeRegistry({
      rules: [
        { org: "weareantenna/*", deny: true },
        { repo: "weareantenna/public", brain: pubBrain },
      ],
    });

    expect(await resolveBrain(pub, { registryPath })).toEqual({ kind: "brain", brain: pubBrain });
    expect(await resolveBrain(priv, { registryPath })).toEqual({ kind: "denied" });
  });

  it("follows a repo across sibling worktree/clone paths (the #182 fix)", async () => {
    // Two checkouts of the SAME repo at sibling paths — like Orca's per-branch worktrees. Neither
    // path is registered by prefix; one identity rule covers both.
    const wtA = await gitRepo("app-branch-a", "git@github.com:weareantenna/app.git");
    const wtB = await gitRepo("app-branch-b", "git@github.com:weareantenna/app.git");
    const antenna = brainPath("antenna");
    await writeRegistry({ rules: [{ org: "weareantenna/*" }], defaultBrain: antenna });

    expect(await resolveBrain(wtA, { registryPath })).toEqual({ kind: "brain", brain: antenna });
    expect(await resolveBrain(wtB, { registryPath })).toEqual({ kind: "brain", brain: antenna });
  });

  it("does not match an org rule for a repo in a different org", async () => {
    const repo = await gitRepo("thing", "git@github.com:someoneelse/thing.git");
    await writeRegistry({ rules: [{ org: "weareantenna/*" }], defaultBrain: brainPath("antenna") });

    expect(await resolveBrain(repo, { registryPath })).toEqual({ kind: "none" });
  });
});

describe("resolveBrain — path, catch-all, default brain", () => {
  it("matches a prefix rule; the longest prefix wins", async () => {
    const deep = await mkdir("work", "acme", "app", "src");
    const broad = brainPath("broad");
    const narrow = brainPath("narrow");
    await writeRegistry({
      rules: [
        { prefix: path.join(root, "work"), brain: broad },
        { prefix: path.join(root, "work", "acme", "app"), brain: narrow },
      ],
    });

    expect(await resolveBrain(deep, { registryPath })).toEqual({ kind: "brain", brain: narrow });
  });

  it("routes an unmatched cwd via a catch-all * rule, but a specific rule still wins", async () => {
    const inside = await mkdir("work", "acme");
    const outside = await mkdir("elsewhere");
    const fallback = brainPath("fallback");
    const acme = brainPath("acme");
    await writeRegistry({
      rules: [
        { prefix: "*", brain: fallback },
        { prefix: path.join(root, "work"), brain: acme },
      ],
    });

    expect(await resolveBrain(inside, { registryPath })).toEqual({ kind: "brain", brain: acme });
    expect(await resolveBrain(outside, { registryPath })).toEqual({
      kind: "brain",
      brain: fallback,
    });
  });

  it("a bare catch-all * routes to the default brain", async () => {
    const anywhere = await mkdir("random");
    const antenna = brainPath("antenna");
    await writeRegistry({ rules: [{ prefix: "*" }], defaultBrain: antenna });

    expect(await resolveBrain(anywhere, { registryPath })).toEqual({
      kind: "brain",
      brain: antenna,
    });
  });

  it("a matched bare allow with no default brain resolves to none (never captures nowhere)", async () => {
    const dir = await mkdir("work");
    await writeRegistry({ rules: [{ prefix: path.join(root, "work") }] });

    expect(await resolveBrain(dir, { registryPath })).toEqual({ kind: "none" });
  });

  it("deny wins over allow on an exact specificity tie", async () => {
    const dir = await mkdir("work");
    const prefix = path.join(root, "work");
    await writeRegistry({
      rules: [
        { prefix, brain: brainPath("x") },
        { prefix, deny: true },
      ],
    });

    expect(await resolveBrain(dir, { registryPath })).toEqual({ kind: "denied" });
  });
});

describe("resolveBrain — env fallback vs matched rules", () => {
  it("falls back to the env brain only when NO rule matches", async () => {
    const dir = await mkdir("unmapped");
    await writeRegistry({ rules: [{ prefix: path.join(root, "work"), brain: brainPath("x") }] });

    expect(await resolveBrain(dir, { registryPath, env: "/env/brain" })).toEqual({
      kind: "brain",
      brain: path.resolve("/env/brain"),
    });
  });

  it("an explicit deny does not fall through to the env brain", async () => {
    const dir = await mkdir("work");
    await writeRegistry({ rules: [{ prefix: path.join(root, "work"), deny: true }] });

    expect(await resolveBrain(dir, { registryPath, env: "/env/brain" })).toEqual({
      kind: "denied",
    });
  });

  it("a matched bare allow without a default does not fall through to the env brain", async () => {
    const dir = await mkdir("work");
    await writeRegistry({ rules: [{ prefix: path.join(root, "work") }] });

    expect(await resolveBrain(dir, { registryPath, env: "/env/brain" })).toEqual({ kind: "none" });
  });
});

describe("resolveBrain — back-compat with legacy mappings (ADR-0011)", () => {
  it("resolves a legacy prefix→brain mapping, longest prefix winning", async () => {
    const deep = await mkdir("work", "acme", "app");
    const broad = brainPath("broad");
    const narrow = brainPath("narrow");
    await writeRegistry({
      mappings: [
        { prefix: path.join(root, "work"), brain: broad },
        { prefix: path.join(root, "work", "acme"), brain: narrow },
      ],
    });

    expect(await resolveBrain(deep, { registryPath })).toEqual({ kind: "brain", brain: narrow });
  });

  it("carries a legacy mapping's remote through (clone-on-demand, ADR-0019)", async () => {
    const dir = await mkdir("work");
    const brain = brainPath("b");
    await writeRegistry({
      mappings: [{ prefix: path.join(root, "work"), brain, remote: "git@github.com:o/b.git" }],
    });

    expect(await resolveBrain(dir, { registryPath })).toEqual({
      kind: "brain",
      brain,
      remote: "git@github.com:o/b.git",
    });
  });

  it("evaluates new rules and legacy mappings together (a repo rule beats a broad legacy prefix)", async () => {
    const repo = await gitRepo("erp", "git@github.com:weareantenna/erp.git");
    const legacyBrain = brainPath("legacy");
    const erpBrain = brainPath("erp");
    await writeRegistry({
      rules: [{ repo: "weareantenna/erp", brain: erpBrain }],
      mappings: [{ prefix: root, brain: legacyBrain }],
    });

    expect(await resolveBrain(repo, { registryPath })).toEqual({ kind: "brain", brain: erpBrain });
  });
});

describe("rule writers: addRule / removeRule / setDefaultBrain (ADR-0024)", () => {
  it("adds a rule, updates it in place by matcher, and resolves it end-to-end", async () => {
    const repo = await gitRepo("erp", "git@github.com:weareantenna/erp.git");
    const first = brainPath("first");
    const second = brainPath("second");

    expect(await addRule({ repo: "weareantenna/erp", brain: first }, { registryPath })).toEqual({
      added: true,
      updated: false,
    });
    expect(await resolveBrain(repo, { registryPath })).toEqual({ kind: "brain", brain: first });

    // Same matcher, new outcome → updated in place (not a duplicate).
    expect(await addRule({ repo: "weareantenna/erp", brain: second }, { registryPath })).toEqual({
      added: false,
      updated: true,
    });
    const reg = await loadRegistryFile({ registryPath });
    expect(reg?.rules).toHaveLength(1);
    expect(await resolveBrain(repo, { registryPath })).toEqual({ kind: "brain", brain: second });
  });

  it("adds a deny rule and a default brain, then a bare allow routes to the default", async () => {
    const repo = await gitRepo("app", "git@github.com:weareantenna/app.git");
    const antenna = brainPath("antenna");
    await setDefaultBrain(antenna, { registryPath });
    await addRule({ org: "weareantenna/*" }, { registryPath }); // bare allow → default

    expect(await resolveBrain(repo, { registryPath })).toEqual({ kind: "brain", brain: antenna });

    await addRule({ repo: "weareantenna/app", deny: true }, { registryPath }); // deny beats org allow
    expect(await resolveBrain(repo, { registryPath })).toEqual({ kind: "denied" });
  });

  it("removeRule deletes by matcher and setDefaultBrain(null) clears the default", async () => {
    const dir = await mkdir("work");
    await addRule({ prefix: path.join(root, "work"), brain: brainPath("b") }, { registryPath });
    expect(await removeRule({ prefix: path.join(root, "work") }, { registryPath })).toEqual({
      removed: 1,
    });
    expect(await resolveBrainDir(dir, { registryPath })).toBeNull();

    await setDefaultBrain(brainPath("d"), { registryPath });
    await setDefaultBrain(null, { registryPath });
    expect((await loadRegistryFile({ registryPath }))?.defaultBrain).toBeUndefined();
  });
});

describe("resolveBrainMapping / resolveBrainDir wrappers collapse denied+none to null", () => {
  it("returns null for a denied cwd (out of scope)", async () => {
    const dir = await mkdir("work");
    await writeRegistry({ rules: [{ prefix: path.join(root, "work"), deny: true }] });

    expect(await resolveBrainMapping(dir, { registryPath })).toBeNull();
    expect(await resolveBrainDir(dir, { registryPath })).toBeNull();
  });

  it("returns null for an unmatched cwd (none), and the brain path when routed", async () => {
    const unmapped = await mkdir("nope");
    const mapped = await mkdir("work");
    const brain = brainPath("b");
    await writeRegistry({ rules: [{ prefix: path.join(root, "work"), brain }] });

    expect(await resolveBrainDir(unmapped, { registryPath })).toBeNull();
    expect(await resolveBrainDir(mapped, { registryPath })).toBe(brain);
  });
});
