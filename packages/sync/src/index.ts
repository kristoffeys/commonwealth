import path from "node:path";
import { parseArgs } from "node:util";
import { Daemon, isRunning, readPid } from "./daemon.js";
import { SyncEngine } from "./engine.js";

/**
 * Commons sync CLI (`commons-sync`). Subcommands:
 *   sync   [--dir DIR]                 one-shot syncOnce, then exit
 *   start  [--dir DIR] [--interval MS] run the resident daemon in the foreground
 *   status [--dir DIR]                 report whether a daemon is running
 *   stop   [--dir DIR]                 signal a running daemon to exit
 *
 * DIR defaults to $COMMONS_BRAIN_DIR, else the current working directory. This file
 * carries NO shebang — tsup's banner adds exactly one at build time.
 */

/** Resolve the brain dir from --dir, else $COMMONS_BRAIN_DIR, else cwd. */
function resolveDir(dirFlag: string | undefined): string {
  const dir = dirFlag ?? process.env.COMMONS_BRAIN_DIR ?? process.cwd();
  return path.resolve(dir);
}

async function cmdSync(dir: string): Promise<void> {
  const engine = new SyncEngine(dir);
  const summary = await engine.syncOnce();
  console.error(
    `[commons-sync] sync: committed=${summary.committed} pulled=${summary.pulled} ` +
      `pushed=${summary.pushed} conflicts=${summary.conflicts.length}`,
  );
}

async function cmdStart(dir: string, intervalMs: number | undefined): Promise<void> {
  const daemon = new Daemon();
  await daemon.start(dir, {
    intervalMs,
    onSync: (s) =>
      console.error(
        `[commons-sync] sync: committed=${s.committed} pulled=${s.pulled} ` +
          `pushed=${s.pushed} conflicts=${s.conflicts.length}`,
      ),
    onError: (err) => console.error("[commons-sync] sync error:", err),
  });
  console.error(`[commons-sync] daemon started on ${dir} (pid ${process.pid})`);

  // Keep the process alive; tear down cleanly on termination signals.
  const shutdown = async (): Promise<void> => {
    console.error("[commons-sync] shutting down");
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
    console.error(`[commons-sync] running on ${dir} (pid ${pid})`);
  } else {
    console.error(`[commons-sync] not running on ${dir}`);
  }
}

async function cmdStop(dir: string): Promise<void> {
  const running = await isRunning(dir);
  const pid = await readPid(dir);
  if (running && pid !== null) {
    process.kill(pid, "SIGTERM");
    console.error(`[commons-sync] sent SIGTERM to pid ${pid}`);
  } else {
    console.error(`[commons-sync] no running daemon on ${dir}`);
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
  const dir = resolveDir(values.dir);
  const interval = values.interval ? Number.parseInt(values.interval, 10) : undefined;

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
      console.error("usage: commons-sync <sync|start|status|stop> [--dir DIR] [--interval MS]");
      process.exit(sub ? 1 : 2);
  }
}

main().catch((err) => {
  console.error("[commons-sync] fatal:", err);
  process.exit(1);
});
