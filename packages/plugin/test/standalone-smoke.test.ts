import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PLUGIN_RUNTIME_FILES } from "../../../scripts/release.mjs";

const sourceRoot = path.resolve(import.meta.dirname, "..");
const temporaryRoots: string[] = [];

function copyPortablePayload(): { installRoot: string; projectRoot: string; home: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "commonwealth-plugin-standalone-"));
  temporaryRoots.push(root);
  const installRoot = path.join(root, "installed", "commonwealth");
  for (const rel of PLUGIN_RUNTIME_FILES) {
    expect(
      lstatSync(path.join(sourceRoot, rel)).isSymbolicLink(),
      `source release asset must not be a symlink: ${rel}`,
    ).toBe(false);
  }
  cpSync(sourceRoot, installRoot, {
    recursive: true,
    filter(source) {
      const rel = path.relative(sourceRoot, source);
      return !["vendor", "test", "scripts"].includes(rel.split(path.sep)[0]);
    },
  });
  const projectRoot = path.join(root, "project");
  const home = path.join(root, "home");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { installRoot, projectRoot, home };
}

function runModule(file: string, args: string[], cwd: string, home: string) {
  return spawnSync(process.execPath, [file, ...args], {
    cwd,
    input: "{}",
    encoding: "utf8",
    timeout: 10_000,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      NODE_PATH: "",
      COMMONWEALTH_DISABLE_HOOKS: "1",
    },
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("standalone marketplace payload", () => {
  it("contains the complete portable runtime inventory with no monorepo or vendor dependency", () => {
    const { installRoot } = copyPortablePayload();

    for (const rel of PLUGIN_RUNTIME_FILES) {
      const file = path.join(installRoot, rel);
      expect(existsSync(file), `missing copied release asset: ${rel}`).toBe(true);
      expect(lstatSync(file).isSymbolicLink(), `release asset must not be a symlink: ${rel}`).toBe(
        false,
      );
    }
    expect(existsSync(path.join(installRoot, "vendor"))).toBe(false);

    const mcp = JSON.parse(readFileSync(path.join(installRoot, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(mcp.mcpServers.commonwealth.command).toBe("npx");
    expect(mcp.mcpServers.commonwealth.args).toEqual([
      "-y",
      expect.stringMatching(/^@cmnwlth\/mcp@\d+\.\d+\.\d+$/),
    ]);
  });

  it("loads runtime modules and executes every host hook from only the copied install", () => {
    const { installRoot, projectRoot, home } = copyPortablePayload();
    const hooksRoot = path.join(installRoot, "hooks");
    const hookEntries: Array<[string, string[]]> = [
      ["session-start.mjs", []],
      ["session-end.mjs", []],
      ["user-prompt-submit.mjs", []],
      ["pre-compact.mjs", []],
      ["capture-worker.mjs", ["{}"]],
      ["codex-hook.mjs", ["SessionStart"]],
      ["codex-hook.mjs", ["UserPromptSubmit"]],
      ["codex-hook.mjs", ["PreCompact"]],
      ["codex-hook.mjs", ["Stop"]],
    ];

    for (const [entry, args] of hookEntries) {
      const result = runModule(path.join(hooksRoot, entry), args, projectRoot, home);
      expect(result.error, `${entry} could not be started`).toBeUndefined();
      expect(result.status, `${entry} failed:\n${result.stderr}`).toBe(0);
      expect(result.stdout).toBe("");
    }

    const libUrl = pathToFileURL(path.join(hooksRoot, "lib.mjs")).href;
    const extractionUrl = pathToFileURL(path.join(hooksRoot, "extraction.mjs")).href;
    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
          const lib = await import(${JSON.stringify(libUrl)});
          const extraction = await import(${JSON.stringify(extractionUrl)});
          const runtime = lib.resolveCurateRuntime();
          const candidates = extraction.parseExtractionOutput(
            JSON.stringify({ candidates: [{ kind: "memory", title: "standalone", body: "ok", tags: [] }] }),
            { strict: true },
          );
          process.stdout.write(JSON.stringify({ runtime, candidates }));
        `,
      ],
      {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: 10_000,
        env: { PATH: process.env.PATH ?? "", HOME: home, NODE_PATH: "" },
      },
    );
    expect(probe.status, probe.stderr).toBe(0);
    const result = JSON.parse(probe.stdout) as {
      runtime: { kind: string; args: string[] };
      candidates: unknown[];
    };
    expect(result.runtime.kind).toBe("npx");
    expect(result.runtime.args).toEqual([
      "-y",
      expect.stringMatching(/^@cmnwlth\/curate@\d+\.\d+\.\d+$/),
    ]);
    expect(result.candidates).toHaveLength(1);
  });
});
