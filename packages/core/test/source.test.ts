import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveProjectSource, slugFromRemote } from "../src/source";

let root: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-source-")));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("slugFromRemote", () => {
  it("reduces common remote URL shapes to owner/repo", () => {
    expect(slugFromRemote("git@github.com:kristoffeys/commonwealth.git")).toBe(
      "kristoffeys/commonwealth",
    );
    expect(slugFromRemote("https://github.com/kristoffeys/commonwealth.git")).toBe(
      "kristoffeys/commonwealth",
    );
    expect(slugFromRemote("https://github.com/kristoffeys/commonwealth")).toBe(
      "kristoffeys/commonwealth",
    );
    expect(slugFromRemote("ssh://git@host.xz/owner/repo")).toBe("owner/repo");
  });
});

describe("resolveProjectSource", () => {
  it("uses the git origin slug when the repo has an origin remote", async () => {
    const repo = path.join(root, "myrepo");
    await fs.mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:acme/widgets.git"]);
    expect(await resolveProjectSource(path.join(repo, "src", "deep"))).toBe("acme/widgets");
  });

  it("falls back to the repo-root basename when there is no origin", async () => {
    const repo = path.join(root, "no-origin-repo");
    await fs.mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    expect(await resolveProjectSource(repo)).toBe("no-origin-repo");
  });

  it("falls back to the cwd basename when there is no git repo", async () => {
    const plain = path.join(root, "plain-dir");
    await fs.mkdir(plain, { recursive: true });
    expect(await resolveProjectSource(plain)).toBe("plain-dir");
  });

  it("returns null for empty input", async () => {
    expect(await resolveProjectSource("")).toBeNull();
  });
});
