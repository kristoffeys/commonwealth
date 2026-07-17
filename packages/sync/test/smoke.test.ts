import { execFileSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initBrain } from "@cmnwlth/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end guard for the BUILT binary (not source): a broken dist entry point — e.g. a
 * duplicate shebang from a stray source shebang colliding with tsup's banner — would crash
 * here but pass every source-imported unit test.
 */

const distEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/**
 * The workspace is built ONCE in vitest globalSetup (#111); this suite must NOT run its own
 * `pnpm -r build` — a build here races the concurrently-running sibling smoke suites, whose
 * tsup `clean` wipes each `dist/` before rewriting it, so a sibling reading `dist/index.js`
 * mid-clean fails with a raw ENOENT (#253). Instead just assert the artifact is present and
 * fail loudly and actionably if it is not.
 */
function assertDistBuilt(entry: string): void {
  if (!existsSync(entry)) {
    throw new Error(
      `Built binary missing: ${entry}\nRun \`pnpm build\` first (the workspace is normally built once in vitest globalSetup).`,
    );
  }
}

let brainDir: string;

beforeAll(async () => {
  assertDistBuilt(distEntry);
  brainDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-sync-smoke-")),
  );
  // A local-only brain (no remote): sync must still exit 0.
  execFileSync("git", ["init", "-q", "-b", "main", brainDir], { stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "smoke@example.com"], { cwd: brainDir });
  execFileSync("git", ["config", "user.name", "smoke"], { cwd: brainDir });
  await initBrain(brainDir, { name: "smoke-brain" });
}, 180_000);

afterAll(async () => {
  if (brainDir) await fs.rm(brainDir, { recursive: true, force: true });
});

describe("built commonwealth-sync binary", () => {
  it("`sync --dir <brain>` exits 0", () => {
    expect(() =>
      execFileSync("node", [distEntry, "sync", "--dir", brainDir], { stdio: "pipe" }),
    ).not.toThrow();
  });

  it("dist entry has exactly one shebang", async () => {
    const content = await fs.readFile(distEntry, "utf8");
    const shebangs = content.split("\n").filter((l) => l.startsWith("#!"));
    expect(shebangs).toHaveLength(1);
    expect(content.startsWith("#!/usr/bin/env node")).toBe(true);
  });
});
