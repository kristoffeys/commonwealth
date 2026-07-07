import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as core from "@cmnwlth/core";

/**
 * `commonwealth service` (#185) — run the sync daemon as a managed, auto-restarting **user-level**
 * background service, so a brain keeps syncing across logout/reboot without a terminal held open.
 * The daemon otherwise runs only in the foreground (`commonwealth sync start`).
 *
 *   commonwealth service install [--dir <brain>]   # generate + load the OS service unit
 *   commonwealth service uninstall                  # unload + remove it
 *   commonwealth service status                     # is it installed / loaded?
 *   commonwealth service restart                    # reload (picks up a new binary after `update`)
 *
 * Per-OS: macOS → a LaunchAgent plist with KeepAlive (auto-restart on crash); Linux → a
 * `systemd --user` unit with Restart=always; Windows → a Scheduled Task at logon with
 * restart-on-failure. `commonwealth update` restarts an installed service so the new binary loads.
 */

const pexec = promisify(execFile);

/** Supported service platforms (a subset of `process.platform`). */
export type ServicePlatform = "darwin" | "linux" | "win32";

/** macOS LaunchAgent label / Windows task name / systemd unit stem. */
export const SERVICE_LABEL = "be.commonwealth.sync";
export const SYSTEMD_UNIT = "commonwealth-sync.service";
export const WINDOWS_TASK = "CommonwealthSync";

/** Parsed `commonwealth service` invocation. */
export interface ServiceOptions {
  action: "install" | "uninstall" | "status" | "restart";
  /** Brain directory to sync (install only); resolved from cwd when omitted. */
  dir?: string;
}

/** Injected effects of {@link runService}; wired for real in {@link defaultServiceDeps}. */
export interface ServiceDeps {
  platform: ServicePlatform;
  homedir: string;
  /** The argv the service should run to start the daemon for `brainDir`. */
  daemonArgv(brainDir: string): string[];
  /** Resolve the brain for a cwd (install without --dir), or null. */
  resolveBrain(cwd: string): Promise<string | null>;
  /** Current working directory (install without --dir). */
  cwd(): string;
  writeFile(file: string, contents: string): Promise<void>;
  removeFile(file: string): Promise<void>;
  fileExists(file: string): Promise<boolean>;
  /** Run a control command (launchctl/systemctl/schtasks); resolves `{ code, stdout, stderr }`. */
  run(
    cmd: string,
    args: string[],
  ): Promise<{ code: number | null; stdout: string; stderr: string }>;
  log(m: string): void;
  out(m: string): void;
}

// --- Pure unit-file generators (one per OS) -------------------------------------------------

/** Escape a string for inclusion in an XML text node (launchd plist). */
function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * A macOS LaunchAgent plist that runs `argv`, at login and kept alive (auto-restart on crash).
 * Stdout/stderr go to a log under `~/Library/Logs` so failures are inspectable. Pure.
 */
export function launchdPlist(label: string, argv: string[], logPath: string): string {
  const args = argv.map((a) => `    <string>${xml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

/**
 * A `systemd --user` service unit that runs `argv`, restarting always, wanted by the default
 * (login) target so it survives logout when lingering is enabled. Pure.
 */
export function systemdUnit(argv: string[]): string {
  const execStart = argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ");
  return `[Unit]
Description=Commonwealth sync daemon
After=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
}

/** The `schtasks /Create` argv that registers a per-user at-logon task running `argv`. Pure. */
export function schtasksCreateArgs(taskName: string, argv: string[]): string[] {
  // schtasks takes a single command string; quote args with spaces.
  const command = argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
  return ["/Create", "/TN", taskName, "/SC", "ONLOGON", "/RL", "LIMITED", "/F", "/TR", command];
}

// --- Per-OS unit locations ------------------------------------------------------------------

function launchdPlistPath(home: string): string {
  return path.join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}
function launchdLogPath(home: string): string {
  return path.join(home, "Library", "Logs", "commonwealth-sync.log");
}
function systemdUnitPath(home: string): string {
  return path.join(home, ".config", "systemd", "user", SYSTEMD_UNIT);
}

// --- Orchestration --------------------------------------------------------------------------

/** Parse `commonwealth service` argv into {@link ServiceOptions}, or null on a usage error. */
export function parseServiceArgs(rest: string[]): ServiceOptions | null {
  const action = rest[0];
  if (
    action !== "install" &&
    action !== "uninstall" &&
    action !== "status" &&
    action !== "restart"
  ) {
    return null;
  }
  let dir: string | undefined;
  for (let i = 1; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--dir") {
      dir = rest[i + 1];
      if (dir === undefined || dir.length === 0) return null;
      i += 1;
    } else if (arg !== undefined && arg.length > 0) {
      return null; // unexpected positional/flag
    }
  }
  return { action, ...(dir ? { dir } : {}) };
}

/**
 * Run a `commonwealth service` action. Pure orchestration over {@link ServiceDeps}.
 * @returns Exit code: 0 success, 1 failure, 2 usage/validation error.
 */
export async function runService(opts: ServiceOptions, deps: ServiceDeps): Promise<number> {
  if (deps.platform !== "darwin" && deps.platform !== "linux" && deps.platform !== "win32") {
    deps.log(`service: unsupported platform ${deps.platform}`);
    return 1;
  }

  if (opts.action === "install") return install(opts, deps);
  if (opts.action === "uninstall") return uninstall(deps);
  if (opts.action === "status") return status(deps);
  return restart(deps);
}

async function install(opts: ServiceOptions, deps: ServiceDeps): Promise<number> {
  // Resolve the brain to sync: --dir, else the brain the cwd maps to.
  const brain = opts.dir ?? (await deps.resolveBrain(deps.cwd()));
  if (!brain) {
    deps.log(
      "service: no brain to sync — run from a wired folder or pass --dir <brain>. " +
        "Wire one with `commonwealth add`.",
    );
    return 2;
  }
  const argv = deps.daemonArgv(brain);

  try {
    if (deps.platform === "darwin") {
      const plist = launchdPlistPath(deps.homedir);
      await deps.writeFile(plist, launchdPlist(SERVICE_LABEL, argv, launchdLogPath(deps.homedir)));
      // `bootout` any stale instance (ignore failure), then `bootstrap` the fresh one.
      const domain = `gui/${process.getuid?.() ?? ""}`;
      await deps.run("launchctl", ["bootout", `${domain}/${SERVICE_LABEL}`]);
      const res = await deps.run("launchctl", ["bootstrap", domain, plist]);
      if (res.code !== 0) return fail(deps, "launchctl bootstrap", res.stderr);
      deps.log(`service: installed and started (launchd ${SERVICE_LABEL}) → syncing ${brain}`);
      return 0;
    }
    if (deps.platform === "linux") {
      const unit = systemdUnitPath(deps.homedir);
      await deps.writeFile(unit, systemdUnit(argv));
      await deps.run("systemctl", ["--user", "daemon-reload"]);
      // enable-linger so the unit runs without an active login session (best-effort).
      await deps.run("loginctl", ["enable-linger", os.userInfo().username]);
      const res = await deps.run("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);
      if (res.code !== 0) return fail(deps, "systemctl enable --now", res.stderr);
      deps.log(
        `service: installed and started (systemd --user ${SYSTEMD_UNIT}) → syncing ${brain}`,
      );
      return 0;
    }
    // win32
    const res = await deps.run("schtasks", schtasksCreateArgs(WINDOWS_TASK, argv));
    if (res.code !== 0) return fail(deps, "schtasks /Create", res.stderr);
    deps.log(`service: installed (Scheduled Task ${WINDOWS_TASK}) → syncing ${brain}`);
    return 0;
  } catch (err) {
    return fail(deps, "install", (err as Error).message);
  }
}

async function uninstall(deps: ServiceDeps): Promise<number> {
  try {
    if (deps.platform === "darwin") {
      const domain = `gui/${process.getuid?.() ?? ""}`;
      await deps.run("launchctl", ["bootout", `${domain}/${SERVICE_LABEL}`]);
      const plist = launchdPlistPath(deps.homedir);
      if (await deps.fileExists(plist)) await deps.removeFile(plist);
    } else if (deps.platform === "linux") {
      await deps.run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
      const unit = systemdUnitPath(deps.homedir);
      if (await deps.fileExists(unit)) await deps.removeFile(unit);
      await deps.run("systemctl", ["--user", "daemon-reload"]);
    } else {
      await deps.run("schtasks", ["/Delete", "/TN", WINDOWS_TASK, "/F"]);
    }
    deps.log("service: uninstalled");
    return 0;
  } catch (err) {
    return fail(deps, "uninstall", (err as Error).message);
  }
}

async function status(deps: ServiceDeps): Promise<number> {
  if (deps.platform === "darwin") {
    const domain = `gui/${process.getuid?.() ?? ""}`;
    const res = await deps.run("launchctl", ["print", `${domain}/${SERVICE_LABEL}`]);
    deps.out(
      res.code === 0 ? `service: loaded (launchd ${SERVICE_LABEL})` : "service: not installed",
    );
    return 0;
  }
  if (deps.platform === "linux") {
    const res = await deps.run("systemctl", ["--user", "is-active", SYSTEMD_UNIT]);
    deps.out(`service: ${res.stdout.trim() || (res.code === 0 ? "active" : "not installed")}`);
    return 0;
  }
  const res = await deps.run("schtasks", ["/Query", "/TN", WINDOWS_TASK]);
  deps.out(res.code === 0 ? `service: registered (${WINDOWS_TASK})` : "service: not installed");
  return 0;
}

/**
 * Restart an installed service so a freshly-updated binary is loaded. Best-effort and safe when no
 * service is installed (used by `commonwealth update`). Never fails the caller.
 */
export async function restart(deps: ServiceDeps): Promise<number> {
  if (deps.platform === "darwin") {
    const domain = `gui/${process.getuid?.() ?? ""}`;
    await deps.run("launchctl", ["kickstart", "-k", `${domain}/${SERVICE_LABEL}`]);
  } else if (deps.platform === "linux") {
    await deps.run("systemctl", ["--user", "restart", SYSTEMD_UNIT]);
  } else {
    await deps.run("schtasks", ["/End", "/TN", WINDOWS_TASK]);
    await deps.run("schtasks", ["/Run", "/TN", WINDOWS_TASK]);
  }
  deps.log("service: restarted");
  return 0;
}

/** True when a Commonwealth sync service is installed on this platform. */
export async function isServiceInstalled(deps: ServiceDeps): Promise<boolean> {
  if (deps.platform === "darwin") return deps.fileExists(launchdPlistPath(deps.homedir));
  if (deps.platform === "linux") return deps.fileExists(systemdUnitPath(deps.homedir));
  const res = await deps.run("schtasks", ["/Query", "/TN", WINDOWS_TASK]);
  return res.code === 0;
}

/**
 * Restart the sync service only if one is installed. Used by `commonwealth update` so an updated
 * binary is picked up automatically. Returns whether a restart happened. Never throws.
 */
export async function restartIfInstalled(deps: ServiceDeps): Promise<boolean> {
  try {
    if (!(await isServiceInstalled(deps))) return false;
    await restart(deps);
    return true;
  } catch {
    return false;
  }
}

function fail(deps: ServiceDeps, what: string, detail: string): number {
  deps.log(`service: ${what} failed: ${detail.trim() || "unknown error"}`);
  return 1;
}

/** The real {@link ServiceDeps}. */
export function defaultServiceDeps(): ServiceDeps {
  return {
    platform: process.platform as ServicePlatform,
    homedir: os.homedir(),
    daemonArgv: (brainDir) => {
      // Run the daemon via THIS cli's entry so the service uses the installed binary.
      const cliEntry = fileURLToPath(new URL("./index.js", import.meta.url));
      return [process.execPath, cliEntry, "sync", "start", "--dir", brainDir];
    },
    resolveBrain: (cwd) => core.resolveBrainDir(cwd),
    cwd: () => process.cwd(),
    writeFile: async (file, contents) => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, contents, "utf8");
    },
    removeFile: (file) => fs.rm(file, { force: true }),
    fileExists: async (file) => {
      try {
        await fs.stat(file);
        return true;
      } catch {
        return false;
      }
    },
    run: async (cmd, args) => {
      try {
        const { stdout, stderr } = await pexec(cmd, args);
        return { code: 0, stdout, stderr };
      } catch (err) {
        const e = err as { code?: number; stdout?: string; stderr?: string };
        return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
      }
    },
    log: (m) => {
      process.stderr.write(`${m}\n`);
    },
    out: (m) => {
      process.stdout.write(`${m}\n`);
    },
  };
}

/** Entry point wired into the CLI dispatch: parse argv, then run. */
export async function cmdService(rest: string[]): Promise<number> {
  const opts = parseServiceArgs(rest);
  if (opts === null) {
    process.stderr.write(
      "usage: commonwealth service <install [--dir <brain>] | uninstall | status | restart>\n",
    );
    return 2;
  }
  return runService(opts, defaultServiceDeps());
}
