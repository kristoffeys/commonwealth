import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end guard: run the *built* binary (not source) and confirm it starts. This is
 * the only test that catches a broken dist entry point (e.g. a duplicate shebang), which
 * source-imported unit tests miss.
 */

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const distEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

let brainDir: string;

beforeAll(async () => {
  // Build core + curate so the dist entry (and its @commons/core import) exist.
  execFileSync("pnpm", ["-r", "build"], { cwd: repoRoot, stdio: "pipe" });
  brainDir = await fs.mkdtemp(path.join(os.tmpdir(), "commons-curate-smoke-"));
}, 120_000);

afterAll(async () => {
  if (brainDir) await fs.rm(brainDir, { recursive: true, force: true });
});

describe("built binary", () => {
  it("runs `list` against an empty brain with exit 0", () => {
    const out = execFileSync("node", [distEntry, "list", "--dir", brainDir], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    // Empty brain: no pending notes, no output rows.
    expect(out.toString().trim()).toBe("");
  });

  it("has exactly one shebang at the top of dist/index.js", async () => {
    const contents = await fs.readFile(distEntry, "utf8");
    const shebangs = contents.split("\n").filter((line) => line.startsWith("#!"));
    expect(shebangs).toHaveLength(1);
    expect(contents.startsWith("#!")).toBe(true);
  });

  it("reports scope check for a cwd (exit 0, prints in/out-scope)", async () => {
    // COMMONS_CONFIG points at a non-existent temp file → empty config → everything in scope.
    const configPath = path.join(brainDir, "config.json");
    const out = execFileSync("node", [distEntry, "scope", "check", "--cwd", brainDir], {
      cwd: repoRoot,
      stdio: "pipe",
      env: { ...process.env, COMMONS_CONFIG: configPath },
    });
    expect(out.toString().trim()).toBe("in-scope");
  });
});
