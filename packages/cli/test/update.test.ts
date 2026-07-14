import { spawnSync } from "node:child_process";
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
  parseCodexInstalledPlugin,
  parseCodexMarketplaceKind,
  runUpdate,
  updateClaudePlugin,
  updateCodexPlugin,
  type UpdateCommandResult,
  type UpdateDeps,
  type UpdateHost,
  type UpdateNoticeDeps,
} from "../src/update.js";

const distEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

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
  calls: {
    installs: Array<{ pm: string; spec: string }>;
    pluginUpdates: UpdateHost[];
    serviceRestarts: number;
    logs: string[];
  };
} {
  const calls = {
    installs: [] as Array<{ pm: string; spec: string }>,
    pluginUpdates: [] as UpdateHost[],
    serviceRestarts: 0,
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
    updatePlugin: (host = "claude") => {
      calls.pluginUpdates.push(host);
      return { ran: true, ok: true };
    },
    restartService: async () => {
      calls.serviceRestarts += 1;
      return false;
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

  it("restarts the sync service after a successful global update (#185)", async () => {
    const { deps, calls } = fakeUpdateDeps({ restartService: async () => true });
    expect(await runUpdate(deps)).toBe(0);
    expect(calls.logs.join("\n")).toContain("restarted the background sync service");
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
    // CLI + host integrations are independent: a failed package install must not skip the host.
    expect(calls.pluginUpdates).toEqual(["claude"]);
  });

  it("also refreshes the plugin after a successful global CLI update", async () => {
    const { deps, calls } = fakeUpdateDeps();
    expect(await runUpdate(deps)).toBe(0);
    expect(calls.installs).toEqual([{ pm: "npm", spec: `${CLI_PACKAGE}@0.2.0` }]);
    expect(calls.pluginUpdates).toEqual(["claude"]);
    expect(calls.logs.join("\n")).toContain("refreshed the Claude Code plugin");
    expect(calls.logs.join("\n")).toContain("restart Claude Code");
  });

  it("refreshes the plugin even when the CLI is already up to date (plugin can lag)", async () => {
    const { deps, calls } = fakeUpdateDeps({ fetchLatest: async () => "0.1.4" });
    expect(await runUpdate(deps)).toBe(0);
    expect(calls.installs).toEqual([]);
    expect(calls.pluginUpdates).toEqual(["claude"]);
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
    expect(calls.pluginUpdates).toEqual([]);
    expect(calls.logs.join("\n")).toContain("claude plugin update commonwealth@commonwealth");
  });

  it("defaults to Claude but can refresh Codex or both explicitly", async () => {
    const one = fakeUpdateDeps({ fetchLatest: async () => "0.1.4" });
    expect(await runUpdate(one.deps)).toBe(0);
    expect(one.calls.pluginUpdates).toEqual(["claude"]);

    const codex = fakeUpdateDeps({ fetchLatest: async () => "0.1.4" });
    expect(await runUpdate(codex.deps, { agent: "codex" })).toBe(0);
    expect(codex.calls.pluginUpdates).toEqual(["codex"]);

    const both = fakeUpdateDeps({ fetchLatest: async () => "0.1.4" });
    expect(await runUpdate(both.deps, { agent: "both" })).toBe(0);
    expect(both.calls.pluginUpdates).toEqual(["claude", "codex"]);
  });

  it("attempts every selected host even when the CLI install and one host fail", async () => {
    const { deps, calls } = fakeUpdateDeps({
      install: () => ({ ok: false, detail: "npm exited with code 1" }),
      updatePlugin: (host = "claude") => {
        calls.pluginUpdates.push(host);
        return host === "claude"
          ? { ran: true, ok: false, detail: "claude update failed", repair: "repair claude" }
          : { ran: true, ok: true };
      },
    });
    expect(await runUpdate(deps, { agent: "both" })).toBe(1);
    expect(calls.pluginUpdates).toEqual(["claude", "codex"]);
    expect(calls.logs.join("\n")).toContain("repair claude");
  });

  it("continues to Codex when the Claude updater throws without leaking its message", async () => {
    const { deps, calls } = fakeUpdateDeps({
      fetchLatest: async () => "0.1.4",
      updatePlugin: (host = "claude") => {
        calls.pluginUpdates.push(host);
        if (host === "claude") throw new Error("TOKEN=secret raw diagnostic");
        return { ran: true, ok: true };
      },
    });
    expect(await runUpdate(deps, { agent: "both" })).toBe(1);
    expect(calls.pluginUpdates).toEqual(["claude", "codex"]);
    expect(calls.logs.join("\n")).not.toContain("TOKEN=secret");
  });

  it("renders independent workspace repair guidance for both hosts", async () => {
    const { deps, calls } = fakeUpdateDeps({ installKind: () => "workspace" });
    expect(await runUpdate(deps, { agent: "both" })).toBe(0);
    const logs = calls.logs.join("\n");
    expect(logs).toContain("claude plugin update commonwealth@commonwealth");
    expect(logs).toContain("codex plugin marketplace upgrade commonwealth");
    expect(logs).toContain("codex plugin add commonwealth@commonwealth");
    expect(calls.pluginUpdates).toEqual([]);
  });
});

describe("host plugin update commands", () => {
  type Call = { command: string; args: string[] };

  function codexRunner(
    options: {
      sourceType?: "git" | "local";
      upgradeStatus?: number;
      addStatus?: number;
      installedStdout?: string;
      marketplaceStdout?: string;
    } = {},
  ): { run: (command: string, args: string[]) => UpdateCommandResult; calls: Call[] } {
    const calls: Call[] = [];
    const run = (command: string, args: string[]): UpdateCommandResult => {
      calls.push({ command, args });
      const joined = args.join(" ");
      if (joined === "plugin list --json") {
        return {
          status: 0,
          stdout:
            options.installedStdout ??
            JSON.stringify({
              installed: [
                {
                  pluginId: "commonwealth@team-market",
                  name: "commonwealth",
                  marketplaceName: "team-market",
                },
              ],
            }),
        };
      }
      if (joined === "plugin marketplace list --json") {
        return {
          status: 0,
          stdout:
            options.marketplaceStdout ??
            JSON.stringify({
              marketplaces: [
                {
                  name: "team-market",
                  marketplaceSource: { sourceType: options.sourceType ?? "git" },
                },
              ],
            }),
        };
      }
      if (joined === "plugin marketplace upgrade team-market") {
        return { status: options.upgradeStatus ?? 0 };
      }
      if (joined === "plugin add commonwealth@team-market") {
        return { status: options.addStatus ?? 0 };
      }
      throw new Error(`unexpected command: ${command} ${joined}`);
    };
    return { run, calls };
  }

  it("upgrades the exact installed Git marketplace then idempotently adds the plugin", () => {
    const { run, calls } = codexRunner();
    expect(updateCodexPlugin(run)).toEqual({ ran: true, ok: true });
    expect(calls).toEqual([
      { command: "codex", args: ["plugin", "list", "--json"] },
      { command: "codex", args: ["plugin", "marketplace", "list", "--json"] },
      { command: "codex", args: ["plugin", "marketplace", "upgrade", "team-market"] },
      { command: "codex", args: ["plugin", "add", "commonwealth@team-market"] },
    ]);
    expect(calls.flatMap((call) => call.args)).not.toContain("remove");
  });

  it("skips marketplace upgrade for a local source but still performs idempotent plugin add", () => {
    const { run, calls } = codexRunner({ sourceType: "local" });
    expect(updateCodexPlugin(run)).toEqual({ ran: true, ok: true });
    expect(calls.map((call) => call.args.join(" "))).not.toContain(
      "plugin marketplace upgrade team-market",
    );
    expect(calls.at(-1)?.args).toEqual(["plugin", "add", "commonwealth@team-market"]);
  });

  it("attempts plugin add even when the Git marketplace upgrade fails", () => {
    const { run, calls } = codexRunner({ upgradeStatus: 9 });
    const result = updateCodexPlugin(run);
    expect(result).toMatchObject({ ran: true, ok: false });
    expect(result.detail).toContain("marketplace upgrade failed");
    expect(calls.at(-1)?.args).toEqual(["plugin", "add", "commonwealth@team-market"]);
  });

  it("returns a non-fatal install repair when Commonwealth is not installed", () => {
    const { run, calls } = codexRunner({ installedStdout: '{"installed":[]}' });
    expect(updateCodexPlugin(run)).toMatchObject({
      ran: false,
      repair: "codex plugin add commonwealth@commonwealth",
    });
    expect(calls).toHaveLength(1);
  });

  it("rejects unsafe structured identities and never leaks raw command output", () => {
    const secret = "TOKEN=super-secret";
    const { run, calls } = codexRunner({
      installedStdout: JSON.stringify({
        installed: [
          {
            pluginId: "commonwealth@team;cat",
            name: "commonwealth",
            marketplaceName: "team;cat",
            diagnostic: secret,
          },
        ],
      }),
    });
    const result = updateCodexPlugin(run);
    expect(result).toMatchObject({ ran: false, ok: false });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(calls).toHaveLength(1);
  });

  it("parses only exact Codex plugin and marketplace identities", () => {
    expect(
      parseCodexInstalledPlugin(
        JSON.stringify({
          installed: [
            {
              pluginId: "commonwealth@team-market",
              name: "commonwealth",
              marketplaceName: "team-market",
            },
          ],
        }),
      ),
    ).toEqual({ marketplace: "team-market", selector: "commonwealth@team-market" });
    expect(
      parseCodexMarketplaceKind(
        JSON.stringify({
          marketplaces: [{ name: "team-market", marketplaceSource: { sourceType: "git" } }],
        }),
        "team-market",
      ),
    ).toBe("git");
  });

  it("uses Claude's direct plugin update command after exact structured discovery", () => {
    const calls: Call[] = [];
    const run = (command: string, args: string[]): UpdateCommandResult => {
      calls.push({ command, args });
      if (args.includes("list")) {
        return { status: 0, stdout: JSON.stringify([{ id: "commonwealth@commonwealth" }]) };
      }
      return { status: 0 };
    };
    expect(updateClaudePlugin(run)).toEqual({ ran: true, ok: true });
    expect(calls).toEqual([
      { command: "claude", args: ["plugin", "list", "--json"] },
      { command: "claude", args: ["plugin", "update", "commonwealth@commonwealth"] },
    ]);
  });
});

describe("update CLI agent parsing", () => {
  it("accepts help without touching the registry and rejects invalid or missing targets", () => {
    const help = spawnSync(process.execPath, [distEntry, "update", "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stderr).toContain("--agent claude|codex|both");

    for (const args of [["--agent", "cursor"], ["--agent"]]) {
      const result = spawnSync(process.execPath, [distEntry, "update", ...args], {
        encoding: "utf8",
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/Invalid --agent|usage: commonwealth update/);
    }
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
