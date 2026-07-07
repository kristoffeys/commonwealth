import { describe, expect, it } from "vitest";
import {
  launchdPlist,
  parseServiceArgs,
  restartService,
  runService,
  schtasksCreateArgs,
  type ServiceDeps,
  type ServicePlatform,
  systemdUnit,
} from "../src/index.js";

// `commonwealth service` (#185): run the sync daemon as a managed OS background service.

const ARGV = ["/usr/bin/node", "/opt/cw/index.js", "sync", "start", "--dir", "/brains/antenna"];

/** Fake {@link ServiceDeps} recording the control commands + written files. */
function fakeDeps(
  platform: ServicePlatform,
  overrides: Partial<ServiceDeps> = {},
): {
  deps: ServiceDeps;
  calls: {
    runs: Array<{ cmd: string; args: string[] }>;
    writes: Array<{ file: string; contents: string }>;
    removes: string[];
    logs: string[];
    out: string[];
  };
} {
  const calls = {
    runs: [] as Array<{ cmd: string; args: string[] }>,
    writes: [] as Array<{ file: string; contents: string }>,
    removes: [] as string[],
    logs: [] as string[],
    out: [] as string[],
  };
  const deps: ServiceDeps = {
    platform,
    homedir: "/home/u",
    daemonArgv: () => ARGV,
    resolveBrain: async () => "/brains/antenna",
    cwd: () => "/work/app",
    writeFile: async (file, contents) => {
      calls.writes.push({ file, contents });
    },
    removeFile: async (file) => {
      calls.removes.push(file);
    },
    fileExists: async () => true,
    run: async (cmd, args) => {
      calls.runs.push({ cmd, args });
      return { code: 0, stdout: "", stderr: "" };
    },
    log: (m) => calls.logs.push(m),
    out: (m) => calls.out.push(m),
    ...overrides,
  };
  return { deps, calls };
}

describe("pure unit generators", () => {
  it("launchd plist runs the argv, at load, kept alive", () => {
    const plist = launchdPlist("be.commonwealth.sync", ARGV, "/home/u/Library/Logs/cw.log");
    expect(plist).toContain("<key>Label</key>");
    expect(plist).toContain("<string>be.commonwealth.sync</string>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    for (const a of ARGV) expect(plist).toContain(`<string>${a}</string>`);
  });

  it("systemd unit runs the argv with Restart=always and default.target", () => {
    const unit = systemdUnit(ARGV);
    expect(unit).toContain(
      "ExecStart=/usr/bin/node /opt/cw/index.js sync start --dir /brains/antenna",
    );
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("schtasks create args register an at-logon task", () => {
    const args = schtasksCreateArgs("CommonwealthSync", ARGV);
    expect(args).toContain("/Create");
    expect(args).toContain("ONLOGON");
    expect(args[args.indexOf("/TN") + 1]).toBe("CommonwealthSync");
  });
});

describe("parseServiceArgs", () => {
  it("parses each action and --dir", () => {
    expect(parseServiceArgs(["install"])).toEqual({ action: "install" });
    expect(parseServiceArgs(["install", "--dir", "/b"])).toEqual({ action: "install", dir: "/b" });
    expect(parseServiceArgs(["uninstall"])).toEqual({ action: "uninstall" });
    expect(parseServiceArgs(["status"])).toEqual({ action: "status" });
    expect(parseServiceArgs(["restart"])).toEqual({ action: "restart" });
  });
  it("rejects unknown actions, stray args, and a dangling --dir", () => {
    expect(parseServiceArgs(["bogus"])).toBeNull();
    expect(parseServiceArgs(["install", "extra"])).toBeNull();
    expect(parseServiceArgs(["install", "--dir"])).toBeNull();
    expect(parseServiceArgs([])).toBeNull();
  });
});

describe("runService install", () => {
  it("macOS: writes the plist and bootstraps it via launchctl", async () => {
    const { deps, calls } = fakeDeps("darwin");
    expect(await runService({ action: "install" }, deps)).toBe(0);
    expect(calls.writes[0].file).toContain("Library/LaunchAgents/be.commonwealth.sync.plist");
    expect(calls.runs.map((r) => r.args[0])).toContain("bootstrap");
  });

  it("Linux: writes the unit, daemon-reloads, and enables --now", async () => {
    const { deps, calls } = fakeDeps("linux");
    expect(await runService({ action: "install" }, deps)).toBe(0);
    expect(calls.writes[0].file).toContain(".config/systemd/user/commonwealth-sync.service");
    const systemctl = calls.runs.filter((r) => r.cmd === "systemctl").flatMap((r) => r.args);
    expect(systemctl).toContain("daemon-reload");
    expect(systemctl).toContain("enable");
  });

  it("fails (exit 2) when no brain resolves and no --dir is given", async () => {
    const { deps } = fakeDeps("linux", { resolveBrain: async () => null });
    expect(await runService({ action: "install" }, deps)).toBe(2);
  });

  it("propagates a control-command failure as exit 1", async () => {
    const { deps } = fakeDeps("darwin", {
      run: async (cmd, args) =>
        args[0] === "bootstrap"
          ? { code: 1, stdout: "", stderr: "boom" }
          : { code: 0, stdout: "", stderr: "" },
    });
    expect(await runService({ action: "install" }, deps)).toBe(1);
  });
});

describe("runService uninstall / restart", () => {
  it("Linux uninstall disables the unit and removes the file", async () => {
    const { deps, calls } = fakeDeps("linux");
    expect(await runService({ action: "uninstall" }, deps)).toBe(0);
    expect(calls.runs.some((r) => r.cmd === "systemctl" && r.args.includes("disable"))).toBe(true);
    expect(calls.removes.some((f) => f.includes("commonwealth-sync.service"))).toBe(true);
  });

  it("macOS restart kickstarts the label", async () => {
    const { deps, calls } = fakeDeps("darwin");
    expect(await restartService(deps)).toBe(0);
    expect(calls.runs.some((r) => r.cmd === "launchctl" && r.args.includes("kickstart"))).toBe(
      true,
    );
  });
});
