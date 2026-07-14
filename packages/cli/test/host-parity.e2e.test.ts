import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultOnboardDeps } from "../src/deps.js";
import { runOnboard, type AgentTarget } from "../src/onboard.js";
import { defaultUpdateDeps, runUpdate } from "../src/update.js";

type AgentInvocation = { host: "claude" | "codex"; args: string[] };

let scratch: string;
let project: string;
let brain: string;
let stateFile: string;
let logFile: string;
let previousEnv: NodeJS.ProcessEnv;

const fakeHost = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const host = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const clean = args.filter((arg) => arg !== "--json");
const statePath = process.env.FAKE_AGENT_STATE;
const logPath = process.env.FAKE_AGENT_LOG;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
fs.appendFileSync(logPath, JSON.stringify({ host, args: clean }) + "\\n");
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const match = (...wanted) => wanted.every((value, index) => clean[index] === value);

if (host === "claude") {
  if (match("plugin", "marketplace", "list")) {
    process.stdout.write(JSON.stringify(state.claude.marketplace ? [{ name: "commonwealth" }] : []));
  } else if (match("plugin", "list")) {
    process.stdout.write(JSON.stringify(state.claude.plugin ? [{ id: "commonwealth@commonwealth", name: "commonwealth", enabled: true, installPath: "/standalone/plugin" }] : []));
  } else if (match("plugin", "marketplace", "add")) {
    state.claude.marketplace = true; save();
  } else if (match("plugin", "install")) {
    state.claude.plugin = true; save();
  } else if (match("plugin", "update") && process.env.FAKE_FAIL_HOST === "claude") {
    process.exitCode = 17;
  } else if (match("mcp", "get")) {
    process.exitCode = 1;
  }
} else if (host === "codex") {
  if (match("plugin", "marketplace", "list")) {
    process.stdout.write(JSON.stringify({ marketplaces: state.codex.marketplace ? [{ name: "commonwealth", marketplaceSource: { sourceType: "git" } }] : [] }));
  } else if (match("plugin", "list")) {
    process.stdout.write(JSON.stringify({ installed: state.codex.plugin ? [{ name: "commonwealth", pluginId: "commonwealth@commonwealth", marketplaceName: "commonwealth" }] : [] }));
  } else if (match("plugin", "marketplace", "add")) {
    state.codex.marketplace = true; save();
  } else if (match("plugin", "add")) {
    state.codex.plugin = true; save();
  } else if (match("plugin", "marketplace", "upgrade") && process.env.FAKE_FAIL_HOST === "codex") {
    process.exitCode = 19;
  }
}
`;

async function invocations(): Promise<AgentInvocation[]> {
  const raw = await fs.readFile(logFile, "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AgentInvocation);
}

async function onboard(target: AgentTarget) {
  const deps = defaultOnboardDeps({ repoRoot: path.join(scratch, "standalone-cli") });
  deps.log = vi.fn();
  return runOnboard(
    project,
    {
      brain,
      yes: true,
      build: false,
      seed: false,
      scope: false,
      daemon: false,
      agent: target,
      syncFolders: [],
      seedRepos: [],
    },
    deps,
  );
}

beforeEach(async () => {
  previousEnv = { ...process.env };
  scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-parity-")));
  project = path.join(scratch, "project");
  brain = path.join(scratch, "brain");
  stateFile = path.join(scratch, "agent-state.json");
  logFile = path.join(scratch, "agent-log.jsonl");
  const bin = path.join(scratch, "bin");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  execFileSync("git", ["init", "-q", project]);
  await fs.writeFile(
    stateFile,
    JSON.stringify({
      claude: { marketplace: false, plugin: false },
      codex: { marketplace: false, plugin: false },
    }),
  );
  await fs.writeFile(logFile, "");
  for (const host of ["claude", "codex"]) {
    const executable = path.join(bin, host);
    await fs.writeFile(executable, fakeHost);
    await fs.chmod(executable, 0o755);
  }

  process.env.PATH = `${bin}${path.delimiter}${previousEnv.PATH ?? ""}`;
  process.env.HOME = scratch;
  process.env.USERPROFILE = scratch;
  process.env.COMMONWEALTH_CONFIG = path.join(scratch, "config.json");
  process.env.COMMONWEALTH_REGISTRY = path.join(scratch, "registry.json");
  process.env.FAKE_AGENT_STATE = stateFile;
  process.env.FAKE_AGENT_LOG = logFile;
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "commit.gpgsign";
  process.env.GIT_CONFIG_VALUE_0 = "false";
  delete process.env.COMMONWEALTH_BRAIN_DIR;
  delete process.env.FAKE_FAIL_HOST;
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.env = previousEnv;
  await fs.rm(scratch, { recursive: true, force: true });
});

describe("Claude/Codex onboarding and update parity (#226)", () => {
  it.each(["claude", "codex", "both"] as const)(
    "onboards %s twice without reinstalling either selected host",
    async (target) => {
      const first = await onboard(target);
      const firstCalls = await invocations();
      const second = await onboard(target);
      const allCalls = await invocations();

      const selected = target === "both" ? ["claude", "codex"] : [target];
      for (const host of selected) {
        expect(first.plugin).toContain("installed");
        const mutation =
          host === "claude"
            ? (call: AgentInvocation) =>
                call.host === host &&
                ((call.args[1] === "marketplace" && call.args[2] === "add") ||
                  call.args[1] === "install")
            : (call: AgentInvocation) =>
                call.host === host &&
                ((call.args[0] === "plugin" && call.args[1] === "add") ||
                  (call.args[1] === "marketplace" && call.args[2] === "add"));
        expect(allCalls.filter(mutation)).toHaveLength(firstCalls.filter(mutation).length);
      }

      if (target === "claude") {
        expect(second.context).toBe("skipped");
        expect(allCalls.some((call) => call.host === "codex")).toBe(false);
      } else {
        expect(second.context).toBe("AGENTS.md emitted");
        await expect(fs.readFile(path.join(project, "AGENTS.md"), "utf8")).resolves.toContain(
          "Commonwealth",
        );
      }
    },
    60_000,
  );

  it.each(["claude", "codex", "both"] as const)(
    "updates %s twice through the production host adapters",
    async (target) => {
      await onboard(target);
      await fs.writeFile(logFile, "");
      const logs: string[] = [];
      const deps = defaultUpdateDeps();
      deps.currentVersion = () => "1.0.0";
      deps.fetchLatest = async () => "1.0.0";
      deps.installKind = () => "npm-global";
      deps.restartService = async () => false;
      deps.log = (message) => logs.push(message);

      expect(await runUpdate(deps, { agent: target })).toBe(0);
      expect(await runUpdate(deps, { agent: target })).toBe(0);
      const calls = await invocations();

      expect(
        calls.filter((call) => call.args.slice(0, 2).join(" ") === "plugin update"),
      ).toHaveLength(target === "claude" || target === "both" ? 2 : 0);
      expect(
        calls.filter(
          (call) =>
            call.host === "codex" &&
            call.args.slice(0, 3).join(" ") === "plugin marketplace upgrade",
        ),
      ).toHaveLength(target === "codex" || target === "both" ? 2 : 0);
      expect(logs.join("\n")).toContain("already up to date");
    },
    60_000,
  );

  it("still updates Codex when the selected Claude refresh fails", async () => {
    await onboard("both");
    await fs.writeFile(logFile, "");
    process.env.FAKE_FAIL_HOST = "claude";
    const deps = defaultUpdateDeps();
    deps.currentVersion = () => "1.0.0";
    deps.fetchLatest = async () => null;
    deps.installKind = () => "npm-global";
    deps.restartService = async () => false;
    deps.log = vi.fn();

    expect(await runUpdate(deps, { agent: "both" })).toBe(1);
    const calls = await invocations();
    expect(calls.some((call) => call.host === "claude" && call.args[1] === "update")).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.host === "codex" && call.args.slice(0, 3).join(" ") === "plugin marketplace upgrade",
      ),
    ).toBe(true);
    expect(calls.some((call) => call.host === "codex" && call.args[1] === "add")).toBe(true);
  }, 60_000);
});
