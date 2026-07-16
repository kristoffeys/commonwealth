import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  manifestStamp,
  resolveProjectManifest,
  resolveProjectSource,
  slugFromRemote,
} from "../src/source";

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

async function writeManifest(dir: string, contents: unknown): Promise<void> {
  const cw = path.join(dir, ".commonwealth");
  await fs.mkdir(cw, { recursive: true });
  await fs.writeFile(
    path.join(cw, "project.json"),
    typeof contents === "string" ? contents : JSON.stringify(contents),
    "utf8",
  );
}

describe("resolveProjectManifest", () => {
  it("finds a manifest declared in a parent directory (walk-up)", async () => {
    const folder = path.join(root, "acme");
    const deep = path.join(folder, "sub", "deep");
    await fs.mkdir(deep, { recursive: true });
    await writeManifest(folder, { project: "acme-engagement", customer: "Acme Corp" });
    expect(await resolveProjectManifest(deep)).toEqual({
      project: "acme-engagement",
      customer: "Acme Corp",
    });
  });

  it("returns null when no manifest exists at or above cwd", async () => {
    const plain = path.join(root, "plain");
    await fs.mkdir(plain, { recursive: true });
    expect(await resolveProjectManifest(plain)).toBeNull();
  });

  it("omits customer when the manifest declares only a project", async () => {
    const folder = path.join(root, "proj-only");
    await fs.mkdir(folder, { recursive: true });
    await writeManifest(folder, { project: "just-a-project" });
    expect(await resolveProjectManifest(folder)).toEqual({ project: "just-a-project" });
  });

  it("tolerates unknown keys (e.g. members) without processing them", async () => {
    const folder = path.join(root, "with-members");
    await fs.mkdir(folder, { recursive: true });
    await writeManifest(folder, {
      project: "p",
      customer: "C",
      members: ["a@x.com"],
      extra: 1,
    });
    expect(await resolveProjectManifest(folder)).toEqual({ project: "p", customer: "C" });
  });

  it("treats a malformed manifest as absent AND emits one stderr breadcrumb", async () => {
    const folder = path.join(root, "broken");
    await fs.mkdir(folder, { recursive: true });
    await writeManifest(folder, "{ not valid json");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await resolveProjectManifest(folder)).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toContain("malformed project manifest");
    } finally {
      spy.mockRestore();
    }
  });

  it("treats a manifest missing a project string as absent (with a breadcrumb)", async () => {
    const folder = path.join(root, "no-project");
    await fs.mkdir(folder, { recursive: true });
    await writeManifest(folder, { customer: "Only Customer" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await resolveProjectManifest(folder)).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects an over-long project id at ingestion (breadcrumb, treated as absent) (#241)", async () => {
    const folder = path.join(root, "overlong");
    await fs.mkdir(folder, { recursive: true });
    await writeManifest(folder, { project: "x".repeat(257) });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await resolveProjectManifest(folder)).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toContain("256-character limit");
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects a project id with a path separator at ingestion (#241)", async () => {
    const folder = path.join(root, "sep");
    await fs.mkdir(folder, { recursive: true });
    await writeManifest(folder, { project: "../../etc/passwd" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await resolveProjectManifest(folder)).toBeNull();
      expect(spy.mock.calls[0]?.[0]).toContain("path separator");
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects a project id with a control character at ingestion (#241)", async () => {
    const folder = path.join(root, "ctrl");
    await fs.mkdir(folder, { recursive: true });
    await writeManifest(folder, { project: "acme\u0007eng" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await resolveProjectManifest(folder)).toBeNull();
      expect(spy.mock.calls[0]?.[0]).toContain("control character");
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps an ordinary project id working after hardening (#241)", async () => {
    const folder = path.join(root, "ok");
    await fs.mkdir(folder, { recursive: true });
    await writeManifest(folder, { project: "acme-eng" });
    expect(await resolveProjectManifest(folder)).toEqual({ project: "acme-eng" });
  });

  it("does not climb above the enclosing git repo root", async () => {
    // Manifest sits ABOVE the repo root; a walk from inside the repo must not reach it.
    await writeManifest(root, { project: "outer-should-not-leak" });
    const repo = path.join(root, "inner-repo");
    const deep = path.join(repo, "src");
    await fs.mkdir(deep, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    expect(await resolveProjectManifest(deep)).toBeNull();
  });

  it("finds a manifest committed at the git repo root", async () => {
    const repo = path.join(root, "declared-repo");
    const deep = path.join(repo, "src", "deep");
    await fs.mkdir(deep, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    await writeManifest(repo, { project: "repo-engagement" });
    expect(await resolveProjectManifest(deep)).toEqual({ project: "repo-engagement" });
  });

  it("returns null for empty input", async () => {
    expect(await resolveProjectManifest("")).toBeNull();
  });
});

describe("manifestStamp", () => {
  it("maps customer to a customer:<slug> tag and keeps the project id", () => {
    expect(manifestStamp({ project: "acme-eng", customer: "Acme Corp" })).toEqual({
      project: "acme-eng",
      tag: "customer:acme-corp",
    });
  });

  it("omits the tag when no customer is declared", () => {
    expect(manifestStamp({ project: "acme-eng" })).toEqual({ project: "acme-eng" });
  });
});
