import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
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
const vendorRoot = path.join(pluginRoot, "vendor");

// The bundle (which runs `pnpm -r build` + vendors the runtime) is produced once in vitest
// globalSetup (#111), so vendor/ reflects the current tree here.
describe("vendored plugin MCP server", () => {
  it("starts without a missing-module crash", async () => {
    // Copy the generated bundle out of the checkout: resolution through the source workspace or
    // its node_modules would hide a broken vendor closure.
    const standaloneRoot = mkdtempSync(path.join(os.tmpdir(), "commonwealth-vendor-smoke-"));
    const standaloneVendor = path.join(standaloneRoot, "vendor");
    cpSync(vendorRoot, standaloneVendor, { recursive: true, dereference: true });
    const vendoredServer = path.join(standaloneVendor, "mcp", "index.js");
    const child = spawn("node", [vendoredServer], {
      cwd: standaloneRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", HOME: standaloneRoot, NODE_PATH: "" },
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    const outcome = await new Promise<{ crashed: boolean; code: number | null }>((resolve) => {
      const timer = setTimeout(() => resolve({ crashed: false, code: null }), 2500);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ crashed: true, code });
      });
    });

    if (!outcome.crashed) {
      const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill();
      await stopped;
    }
    rmSync(standaloneRoot, { recursive: true, force: true });
    // A healthy stdio server waits for input and never exits on its own within the window.
    expect(outcome.crashed, `server exited early (code ${outcome.code}):\n${stderr}`).toBe(false);
    expect(stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(stderr).not.toContain("Cannot find module");
  }, 30_000);
});
