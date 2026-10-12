import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initBrain, loadRegistryFile, persistProjectAliasMap } from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cmdJoin, registryOrgs } from "../src/join.js";

/** `commonwealth join` clones a team brain and routes the orgs its project registry lists. */

let scratch: string;
let remote: string;
let registryPath: string;

beforeEach(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-join-")));
  const origin = path.join(scratch, "origin");
  await initBrain(origin, { name: "team" });
  await persistProjectAliasMap(origin, (m) => {
    m.o2o = { sources: ["o2o-Bicycle-leasing/*"] };
    m.spardex = { sources: ["weareantenna/spardex", "erp"] };
  });
  const git = (...a: string[]) => execFileSync("git", ["-C", origin, ...a], { stdio: "ignore" });
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "registry");
  remote = path.join(scratch, "remote.git");
  execFileSync("git", ["clone", "-q", "--bare", origin, remote]);
  registryPath = path.join(scratch, "config.json");
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

describe("commonwealth join", () => {
  it("lists the registry's git orgs, lowercased, ignoring folder-name sources", () => {
    expect(
      registryOrgs({ a: { sources: ["O2O/*", "erp", "acme/web"] }, b: { sources: ["acme/api"] } }),
    ).toEqual(["acme", "o2o"]);
  });

  it("clones the brain and routes each registry org to it, keeping an existing rule", async () => {
    await fs.writeFile(
      registryPath,
      JSON.stringify({ rules: [{ org: "weareantenna/*", brain: "/elsewhere" }] }),
    );
    const brain = path.join(scratch, "joined");
    const lines: string[] = [];

    const code = await cmdJoin([remote, "--brain", brain], {
      registryPath,
      log: (l) => lines.push(l),
    });

    expect(code).toBe(0);
    await expect(
      fs.access(path.join(brain, ".commonwealth", "projects.json")),
    ).resolves.toBeUndefined();
    const rules = (await loadRegistryFile({ registryPath }))!.rules!;
    expect(rules).toContainEqual({ org: "weareantenna/*", brain: "/elsewhere" });
    expect(rules.find((r) => r.org?.toLowerCase() === "o2o-bicycle-leasing/*")?.brain).toBe(brain);
    expect(lines.join("\n")).toContain("kept your existing rule");

    // Re-running is a no-op apart from reporting.
    expect(await cmdJoin([remote, "--brain", brain], { registryPath, log: () => {} })).toBe(0);
    expect((await loadRegistryFile({ registryPath }))!.rules).toHaveLength(2);
  });

  it("fails with exit 1 on a remote it cannot clone", async () => {
    const code = await cmdJoin(
      [path.join(scratch, "missing.git"), "--brain", path.join(scratch, "x")],
      {
        registryPath,
        log: () => {},
      },
    );
    expect(code).toBe(1);
  });
});
