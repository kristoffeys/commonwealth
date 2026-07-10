import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusCache } from "@cmnwlth/core";
import {
  installStatusLine,
  runStatusline,
  type StatuslineEnv,
  uninstallStatusLine,
} from "../src/statusline";

function makeEnv(over: Partial<StatuslineEnv> = {}): StatuslineEnv {
  return {
    cwd: "/work/acme/app",
    resolveBrain: vi.fn(async () => ({ kind: "brain", brain: "/brains/acme" })),
    readCache: vi.fn(async () => ({}) as StatusCache),
    syncing: vi.fn(async () => false),
    ...over,
  };
}

describe("runStatusline (#197)", () => {
  it("renders the cached status for the resolved brain", async () => {
    const env = makeEnv({
      readCache: vi.fn(async () => ({
        "/brains/acme": {
          brain: "acme",
          brainDir: "/brains/acme",
          score: 88,
          total: 20,
          pending: 2,
          ts: 1,
        },
      })),
      syncing: vi.fn(async () => true),
    });
    expect(await runStatusline(env)).toBe("🧠 acme · 88/100 · 2 pending · ⇅");
  });

  it("degrades to the brain-dir basename when the cache is cold", async () => {
    const env = makeEnv(); // empty cache
    expect(await runStatusline(env)).toBe("🧠 acme");
  });

  it('returns "" when the cwd maps to no brain (empty statusline, not an error)', async () => {
    const denied = makeEnv({ resolveBrain: vi.fn(async () => ({ kind: "denied" })) });
    expect(await runStatusline(denied)).toBe("");
    const none = makeEnv({ resolveBrain: vi.fn(async () => ({ kind: "none" })) });
    expect(await runStatusline(none)).toBe("");
  });
});

describe("install/uninstall statusLine (#197)", () => {
  let dir: string;
  let settings: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-statusline-"));
    settings = path.join(dir, ".claude", "settings.json");
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("installs into a fresh (absent) settings file", async () => {
    expect(await installStatusLine(settings)).toBe("installed");
    const parsed = JSON.parse(await fs.readFile(settings, "utf8"));
    expect(parsed.statusLine).toEqual({
      type: "command",
      command: "commonwealth statusline",
      padding: 0,
    });
  });

  it("is idempotent — a second install reports already", async () => {
    await installStatusLine(settings);
    expect(await installStatusLine(settings)).toBe("already");
  });

  it("preserves other settings keys when installing", async () => {
    await fs.mkdir(path.dirname(settings), { recursive: true });
    await fs.writeFile(settings, JSON.stringify({ model: "opus" }), "utf8");
    await installStatusLine(settings);
    const parsed = JSON.parse(await fs.readFile(settings, "utf8"));
    expect(parsed.model).toBe("opus");
    expect(parsed.statusLine.command).toBe("commonwealth statusline");
  });

  it("refuses to clobber a different existing statusLine (conflict)", async () => {
    await fs.mkdir(path.dirname(settings), { recursive: true });
    await fs.writeFile(
      settings,
      JSON.stringify({ statusLine: { type: "command", command: "my-own-thing" } }),
      "utf8",
    );
    expect(await installStatusLine(settings)).toBe("conflict");
    // Untouched.
    const parsed = JSON.parse(await fs.readFile(settings, "utf8"));
    expect(parsed.statusLine.command).toBe("my-own-thing");
  });

  it("uninstall removes ours, leaves a foreign one, and reports absent when none", async () => {
    expect(await uninstallStatusLine(settings)).toBe("absent");

    await installStatusLine(settings);
    expect(await uninstallStatusLine(settings)).toBe("removed");
    const parsed = JSON.parse(await fs.readFile(settings, "utf8"));
    expect(parsed.statusLine).toBeUndefined();

    await fs.writeFile(
      settings,
      JSON.stringify({ statusLine: { type: "command", command: "my-own-thing" } }),
      "utf8",
    );
    expect(await uninstallStatusLine(settings)).toBe("conflict");
  });
});
