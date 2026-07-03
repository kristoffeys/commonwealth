import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * End-to-end guard for the vendored plugin runtime. `bundle.mjs` copies each package's dist
 * PLUS its full runtime dependency closure into `vendor/`. If the closure walk misses a
 * transitive dep (as it once did for `zod-to-json-schema`, pulled in by the MCP SDK), the
 * vendored server crashes at startup with ERR_MODULE_NOT_FOUND the moment Claude Code launches
 * it — and since the plugin is the sole MCP delivery path (ADR-0012), that means no MCP at all.
 *
 * This test rebuilds the bundle and confirms the vendored MCP server actually STARTS (a missing
 * module exits synchronously with code 1 during import, so "still alive after a short window"
 * reliably distinguishes a healthy bundle from a broken one).
 */

const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
const vendoredServer = path.join(pluginRoot, "vendor", "mcp", "index.js");

// The bundle (which runs `pnpm -r build` + vendors the runtime) is produced once in vitest
// globalSetup (#111), so vendor/ reflects the current tree here.
describe("vendored plugin MCP server", () => {
  it("starts without a missing-module crash", async () => {
    const child = spawn("node", [vendoredServer], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    const outcome = await new Promise<{ crashed: boolean; code: number | null }>((resolve) => {
      const timer = setTimeout(() => resolve({ crashed: false, code: null }), 2500);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ crashed: true, code });
      });
    });

    child.kill();
    // A healthy stdio server waits for input and never exits on its own within the window.
    expect(outcome.crashed, `server exited early (code ${outcome.code}):\n${stderr}`).toBe(false);
    expect(stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(stderr).not.toContain("Cannot find module");
  }, 30_000);
});
