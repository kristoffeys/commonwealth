import path from "node:path";
import { parseArgs } from "node:util";
import { ensureBrainCloned, resolveBrainMapping, type ResolvedBrain } from "@cmnwlth/core";
import { Daemon, isRunning, readPid } from "./daemon.js";
import { SyncEngine } from "./engine.js";
import { formatSyncSummary } from "./format.js";

/**
 * Commonwealth sync CLI (`commonwealth-sync`). Subcommands:
 *   sync   [--dir DIR]                 one-shot syncOnce, then exit
 *   start  [--dir DIR] [--interval MS] run the resident daemon in the foreground
 *   status [--dir DIR]                 report whether a daemon is running
 *   stop   [--dir DIR]                 signal a running daemon to exit
 *
 * DIR resolves as: `--dir` → `$COMMONWEALTH_BRAIN_DIR` → `@cmnwlth/core`'s registry
 * resolver against the cwd (marker → ancestor-brain → user registry, #69) → `null`. This
 * file carries NO shebang — tsup's banner adds exactly one at build time.
 */

/**
 * Resolve the brain dir for the cwd, or `null` when none is configured (#69). Consulting the
 * registry (not just cwd) means `commonwealth-sync status` reports on the brain the working
 * directory actually maps to — the same one the MCP server and hooks use.
 */
async function resolveMapping(dirFlag: string | undefined): Promise<ResolvedBrain | null> {
  if (dirFlag && dirFlag.length > 0) return { brain: path.resolve(dirFlag) };
  const env = process.env.COMMONWEALTH_BRAIN_DIR;
  if (env && env.length > 0) return { brain: path.resolve(env) };
  return resolveBrainMapping(process.cwd());
}

async function cmdSync(dir: string): Promise<void> {
  const engine = new SyncEngine(dir);
  const summary = await engine.syncOnce();
  console.error(formatSyncSummary(summary));
}

async function cmdStart(dir: string, intervalMs: number | undefined): Promise<void> {
  const daemon = new Daemon();
  await daemon.start(dir, {
    intervalMs,
    onSync: (s) => console.error(formatSyncSummary(s)),
    onError: (err) => console.error("[commonwealth-sync] sync error:", err),
  });
  console.error(`[commonwealth-sync] daemon started on ${dir} (pid ${process.pid})`);

  // Keep the process alive; tear down cleanly on termination signals.
  const shutdown = async (): Promise<void> => {
    console.error("[commonwealth-sync] shutting down");
    await daemon.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

async function cmdStatus(dir: string): Promise<void> {
  const running = await isRunning(dir);
  const pid = await readPid(dir);
  if (running) {
    console.error(`[commonwealth-sync] running on ${dir} (pid ${pid})`);
  } else {
    console.error(`[commonwealth-sync] not running on ${dir}`);
  }
}

async function cmdStop(dir: string): Promise<void> {
  const running = await isRunning(dir);
  const pid = await readPid(dir);
  if (running && pid !== null) {
    process.kill(pid, "SIGTERM");
    console.error(`[commonwealth-sync] sent SIGTERM to pid ${pid}`);
  } else {
    console.error(`[commonwealth-sync] no running daemon on ${dir}`);
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      dir: { type: "string" },
      interval: { type: "string" },
    },
  });

  const sub = positionals[0];
  const mapping = await resolveMapping(values.dir);
  if (mapping === null) {
    console.error(
      `[commonwealth-sync] no Commonwealth brain configured for ${process.cwd()} — run ` +
        `\`commonwealth init\` here, add a registry mapping, or pass --dir <brain>.`,
    );
    process.exit(1);
  }
  const dir = mapping.brain;
  const interval = values.interval ? Number.parseInt(values.interval, 10) : undefined;

  // Clone-on-demand (ADR-0019): syncing actions need the brain materialized. `status`/`stop` don't
  // clone — they only report on / signal a running daemon. The clone runs under the user's git
  // identity, so a no-access remote fails here with git's own error (that IS the access check).
  if (sub === "sync" || sub === "start") {
    const outcome = await ensureBrainCloned(dir, mapping.remote);
    if (outcome.status === "cloned") console.error(`[commonwealth-sync] cloned brain into ${dir}`);
    else if (outcome.status === "no-remote") {
      // "no-remote" implies the brain is missing (ensureBrainCloned returns "exists" otherwise).
      console.error(
        `[commonwealth-sync] brain ${dir} is not cloned and has no remote to clone from — ` +
          `re-run \`commonwealth init\`, or add a "remote" to its registry mapping.`,
      );
      process.exit(1);
    } else if (outcome.status === "failed") {
      console.error(
        `[commonwealth-sync] could not clone brain from ${mapping.remote}: ${outcome.error}\n` +
          `Check your git access to that remote (SSH agent / credential helper).`,
      );
      process.exit(1);
    }
  }

  switch (sub) {
    case "sync":
      await cmdSync(dir);
      return;
    case "start":
      await cmdStart(
        dir,
        interval !== undefined && Number.isFinite(interval) ? interval : undefined,
      );
      return; // daemon keeps the event loop alive
    case "status":
      await cmdStatus(dir);
      return;
    case "stop":
      await cmdStop(dir);
      return;
    default:
      console.error(
        "usage: commonwealth-sync <sync|start|status|stop> [--dir DIR] [--interval MS]",
      );
      process.exit(sub ? 1 : 2);
  }
}

main().catch((err) => {
  console.error("[commonwealth-sync] fatal:", err);
  process.exit(1);
});
