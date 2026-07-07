import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLI_PACKAGE,
  cliVersion,
  defaultUpdateCachePath,
  detectInstallKind,
  isNewer,
  maybeNotifyUpdate,
  runUpdate,
  type UpdateDeps,
  type UpdateNoticeDeps,
} from "../src/update.js";

describe("cliVersion", () => {
  it("matches this package's package.json version", () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { version: string };
    expect(cliVersion()).toBe(pkg.version);
    expect(cliVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("isNewer", () => {
  it("compares semver numerically, not lexically", () => {
    expect(isNewer("0.1.5", "0.1.4")).toBe(true);
    expect(isNewer("0.1.10", "0.1.9")).toBe(true);
    expect(isNewer("1.0.0", "0.9.9")).toBe(true);
    expect(isNewer("0.1.4", "0.1.4")).toBe(false);
    expect(isNewer("0.1.3", "0.1.4")).toBe(false);
  });

  it("treats unparseable versions as not-newer", () => {
    expect(isNewer("latest", "0.1.4")).toBe(false);
    expect(isNewer("0.1.5", "garbage")).toBe(false);
  });
});

describe("detectInstallKind", () => {
  it("classifies this source tree as a workspace checkout", () => {
    expect(detectInstallKind()).toBe("workspace");
  });

  it("classifies an _npx cache path and a pnpm global path", () => {
    const npxUrl = "file:///home/u/.npm/_npx/abc123/node_modules/@cmnwlth/cli/dist/index.js";
    expect(detectInstallKind(npxUrl)).toBe("npx");
    const pnpmUrl = "file:///home/u/pnpm/global/5/node_modules/@cmnwlth/cli/dist/index.js";
    expect(detectInstallKind(pnpmUrl)).toBe("pnpm-global");
    const npmUrl = "file:///usr/lib/node_modules/@cmnwlth/cli/dist/index.js";
    expect(detectInstallKind(npmUrl)).toBe("npm-global");
  });
});

/** Build fake {@link UpdateDeps} that record calls; override per test. */
function fakeUpdateDeps(overrides: Partial<UpdateDeps> = {}): {
  deps: UpdateDeps;
  calls: { installs: Array<{ pm: string; spec: string }>; pluginUpdates: number; logs: string[] };
} {
  const calls = {
    installs: [] as Array<{ pm: string; spec: string }>,
    pluginUpdates: 0,
    logs: [] as string[],
  };
  const deps: UpdateDeps = {
    currentVersion: () => "0.1.4",
    fetchLatest: async () => "0.2.0",
    installKind: () => "npm-global",
    install: (pm, spec) => {
      calls.installs.push({ pm, spec });
      return { ok: true };
    },
    updatePlugin: () => {
      calls.pluginUpdates += 1;
      return { ran: true, ok: true };
    },
    log: (m) => calls.logs.push(m),
    ...overrides,
  };
  return { deps, calls };
}

describe("runUpdate", () => {
  it("installs the exact latest version via npm for a global npm install", async () => {
    const { deps, calls } = fakeUpdateDeps();
    expect(await runUpdate(deps)).toBe(0);
    expect(calls.installs).toEqual([{ pm: "npm", spec: `${CLI_PACKAGE}@0.2.0` }]);
    expect(calls.logs.join("\n")).toContain("updated to v0.2.0");
  });

  it("uses pnpm for a pnpm-global install", async () => {
    const { deps, calls } = fakeUpdateDeps({ installKind: () => "pnpm-global" });
    expect(await runUpdate(deps)).toBe(0);
    expect(calls.installs).toEqual([{ pm: "pnpm", spec: `${CLI_PACKAGE}@0.2.0` }]);
  });

  it("is a no-op when already up to date", async () => {
    const { deps, calls } = fakeUpdateDeps({ fetchLatest: async () => "0.1.4" });
    expect(await runUpdate(deps)).toBe(0);
    expect(calls.installs).toEqual([]);
    expect(calls.logs.join("\n")).toContain("already up to date");
  });

  it("prints git guidance (no install) for a workspace checkout", async () => {
    const { deps, calls } = fakeUpdateDeps({ installKind: () => "workspace" });
    expect(await runUpdate(deps)).toBe(0);
    expect(calls.installs).toEqual([]);
    expect(calls.logs.join("\n")).toContain("git pull && pnpm install && pnpm build");
  });

  it("prints npx guidance (no install) for an npx run", async () => {
    const { deps, calls } = fakeUpdateDeps({ installKind: () => "npx" });
    expect(await runUpdate(deps)).toBe(0);
    expect(calls.installs).toEqual([]);
    expect(calls.logs.join("\n")).toContain(`npx ${CLI_PACKAGE}@latest`);
  });

  it("exits 1 when the registry is unreachable", async () => {
    const { deps, calls } = fakeUpdateDeps({ fetchLatest: async () => null });
    expect(await runUpdate(deps)).toBe(1);
    expect(calls.logs.join("\n")).toContain("could not reach the npm registry");
  });

  it("exits 1 when the install fails", async () => {
    const { deps, calls } = fakeUpdateDeps({
      install: () => ({ ok: false, detail: "npm exited with code 1" }),
    });
    expect(await runUpdate(deps)).toBe(1);
    expect(calls.logs.join("\n")).toContain("install failed (npm exited with code 1)");
    // A failed CLI install short-circuits — the plugin refresh is not attempted.
    expect(calls.pluginUpdates).toBe(0);
  });

  it("also refreshes the plugin after a successful global CLI update", async () => {
    const { deps, calls } = fakeUpdateDeps();
    expect(await runUpdate(deps)).toBe(0);
    expect(calls.installs).toEqual([{ pm: "npm", spec: `${CLI_PACKAGE}@0.2.0` }]);
    expect(calls.pluginUpdates).toBe(1);
    expect(calls.logs.join("\n")).toContain("refreshed the Claude Code plugin");
    expect(calls.logs.join("\n")).toContain("restart Claude Code");
  });

  it("refreshes the plugin even when the CLI is already up to date (plugin can lag)", async () => {
    const { deps, calls } = fakeUpdateDeps({ fetchLatest: async () => "0.1.4" });
    expect(await runUpdate(deps)).toBe(0);
    expect(calls.installs).toEqual([]);
    expect(calls.pluginUpdates).toBe(1);
  });

  it("treats a plugin refresh skip (no claude / not installed) as non-fatal", async () => {
    const { deps, calls } = fakeUpdateDeps({
      updatePlugin: () => ({ ran: false, ok: false, detail: "claude CLI not found" }),
    });
    expect(await runUpdate(deps)).toBe(0);
    expect(calls.logs.join("\n")).toContain("skipped plugin refresh (claude CLI not found)");
  });

  it("exits 1 when the plugin refresh runs and fails", async () => {
    const { deps, calls } = fakeUpdateDeps({
      updatePlugin: () => ({
        ran: true,
        ok: false,
        detail: "claude plugin update exited with code 1",
      }),
    });
    expect(await runUpdate(deps)).toBe(1);
    expect(calls.logs.join("\n")).toContain(
      "plugin refresh failed (claude plugin update exited with code 1)",
    );
  });

  it("prints the plugin-update command (does not auto-run) for a workspace checkout", async () => {
    const { deps, calls } = fakeUpdateDeps({ installKind: () => "workspace" });
    expect(await runUpdate(deps)).toBe(0);
    expect(calls.pluginUpdates).toBe(0);
    expect(calls.logs.join("\n")).toContain("claude plugin update commonwealth@commonwealth");
  });
});

describe("maybeNotifyUpdate", () => {
  let dir: string;
  let cachePath: string;

  /** Fake {@link UpdateNoticeDeps}: TTY, clean env, current v0.1.4, registry says `latest`. */
  function noticeDeps(overrides: Partial<UpdateNoticeDeps> = {}): {
    deps: UpdateNoticeDeps;
    calls: { fetches: number; logs: string[] };
  } {
    const calls = { fetches: 0, logs: [] as string[] };
    const deps: UpdateNoticeDeps = {
      currentVersion: () => "0.1.4",
      fetchLatest: async () => {
        calls.fetches += 1;
        return "0.2.0";
      },
      cachePath,
      isTTY: true,
      env: {},
      now: () => 1_000_000_000_000,
      log: (m) => calls.logs.push(m),
      ...overrides,
    };
    return { deps, calls };
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-update-"));
    cachePath = path.join(dir, "update-check.json");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("fetches, caches, and notifies when a newer version is published", async () => {
    const { deps, calls } = noticeDeps();
    await maybeNotifyUpdate(deps);

    expect(calls.fetches).toBe(1);
    expect(calls.logs.join("\n")).toContain("update available: v0.1.4 -> v0.2.0");
    const cache = JSON.parse(await fs.readFile(cachePath, "utf8")) as { latest: string };
    expect(cache.latest).toBe("0.2.0");
  });

  it("uses the fresh cache without another registry hit", async () => {
    await fs.writeFile(
      cachePath,
      JSON.stringify({ checkedAt: 1_000_000_000_000 - 1000, latest: "0.2.0" }),
    );
    const { deps, calls } = noticeDeps();
    await maybeNotifyUpdate(deps);

    expect(calls.fetches).toBe(0);
    expect(calls.logs.join("\n")).toContain("update available");
  });

  it("re-fetches once the cache is older than a day", async () => {
    const twoDaysAgo = 1_000_000_000_000 - 2 * 24 * 60 * 60 * 1000;
    await fs.writeFile(cachePath, JSON.stringify({ checkedAt: twoDaysAgo, latest: "0.1.4" }));
    const { deps, calls } = noticeDeps();
    await maybeNotifyUpdate(deps);

    expect(calls.fetches).toBe(1);
    expect(calls.logs.join("\n")).toContain("v0.2.0");
  });

  it("stays silent when up to date", async () => {
    const { deps, calls } = noticeDeps({ fetchLatest: async () => "0.1.4" });
    await maybeNotifyUpdate(deps);
    expect(calls.logs).toEqual([]);
  });

  it("backs off for a day when the registry is unreachable (still no notice)", async () => {
    const { deps, calls } = noticeDeps({ fetchLatest: async () => null });
    await maybeNotifyUpdate(deps);

    expect(calls.logs).toEqual([]);
    // The failed attempt is recorded, so the next command within TTL fetches nothing.
    const cache = JSON.parse(await fs.readFile(cachePath, "utf8")) as { checkedAt: number };
    expect(cache.checkedAt).toBe(1_000_000_000_000);
    const again = noticeDeps({ fetchLatest: async () => null });
    await maybeNotifyUpdate(again.deps);
    expect(again.calls.fetches).toBe(0);
  });

  it("does nothing off-TTY, in CI, or when opted out", async () => {
    for (const overrides of [
      { isTTY: false },
      { env: { CI: "1" } },
      { env: { COMMONWEALTH_NO_UPDATE_CHECK: "1" } },
    ] satisfies Array<Partial<UpdateNoticeDeps>>) {
      const { deps, calls } = noticeDeps(overrides);
      await maybeNotifyUpdate(deps);
      expect(calls.fetches).toBe(0);
      expect(calls.logs).toEqual([]);
    }
  });

  it("survives a corrupt cache file", async () => {
    await fs.writeFile(cachePath, "{not json");
    const { deps, calls } = noticeDeps();
    await maybeNotifyUpdate(deps);
    expect(calls.fetches).toBe(1);
    expect(calls.logs.join("\n")).toContain("update available");
  });
});

describe("defaultUpdateCachePath", () => {
  it("lands next to a redirected COMMONWEALTH_CONFIG", () => {
    const p = defaultUpdateCachePath({ COMMONWEALTH_CONFIG: "/tmp/x/config.json" });
    expect(p).toBe(path.join("/tmp/x", "update-check.json"));
  });

  it("defaults to ~/.commonwealth/update-check.json", () => {
    const p = defaultUpdateCachePath({});
    expect(p).toBe(path.join(os.homedir(), ".commonwealth", "update-check.json"));
  });
});
