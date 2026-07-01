import { promises as fs } from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { SyncEngine, type SyncSummary } from "./engine.js";
import { SerialQueue } from "./queue.js";

/** Options for {@link Daemon.start}. */
export interface DaemonOptions {
  /** Background poll interval for inbound teammate changes (ms). Default 15000. */
  intervalMs?: number;
  /** Debounce window for filesystem-triggered syncs (ms). Default 500. */
  debounceMs?: number;
  /** Called after each background sync completes (for tests / logging). */
  onSync?: (summary: SyncSummary) => void;
  /** Called if a background sync throws (for tests / logging). */
  onError?: (err: unknown) => void;
}

/** Directory Commons owns for local process state (PID file, etc.). */
const COMMONS_DIR = ".commons";
const PID_FILE = "sync.pid";

/**
 * Chokidar v4 `ignored` predicate. v4 takes a FUNCTION (not globs): the full path is
 * tested. We skip git internals, the derived (gitignored) index, sqlite sidecars, and
 * temp files — none of which should trigger a sync.
 */
function makeIgnored(brainDir: string): (p: string) => boolean {
  const gitDir = path.join(brainDir, ".git");
  const indexDir = path.join(brainDir, "index");
  const commonsDir = path.join(brainDir, COMMONS_DIR);
  const commonsMd = path.join(brainDir, "COMMONS.md");
  return (p: string): boolean => {
    if (p === gitDir || p.startsWith(gitDir + path.sep)) return true;
    if (p === indexDir || p.startsWith(indexDir + path.sep)) return true;
    if (p === commonsDir || p.startsWith(commonsDir + path.sep)) return true;
    if (/\.db(-shm|-wal)?$/.test(p)) return true;
    if (p.endsWith(".tmp")) return true;
    // Derived artifacts are rewritten by every sync (regenerateDerived); watching them
    // would make each sync retrigger the next — an unbounded loop. They are never a
    // legitimate sync trigger, so ignore them.
    if (p === commonsMd) return true;
    if (path.basename(p) === "INDEX.md") return true;
    return false;
  };
}

/**
 * The resident sync daemon (ADR-0006): watches a brain working copy and continuously
 * converges it with the remote. On any filesystem change it debounces then runs a sync;
 * a periodic poll pulls inbound teammate changes even without local edits. Every sync
 * runs through the engine's serial queue, so watcher and poll can never race.
 */
export class Daemon {
  private engine?: SyncEngine;
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private debounceTimer?: NodeJS.Timeout;
  private readonly queue = new SerialQueue();

  /**
   * Start watching + polling `brainDir`. Runs an initial sync, then wires the watcher and
   * poll loop. Writes a PID file so a separate CLI `status`/`stop` can find this process.
   */
  async start(brainDir: string, opts: DaemonOptions = {}): Promise<void> {
    const intervalMs = opts.intervalMs ?? 15_000;
    const debounceMs = opts.debounceMs ?? 500;
    this.engine = new SyncEngine(brainDir, { queue: this.queue });

    await writePid(brainDir);

    const runSync = async (): Promise<void> => {
      try {
        const summary = await this.engine!.syncOnce();
        opts.onSync?.(summary);
      } catch (err) {
        opts.onError?.(err);
      }
    };

    // Initial reconcile on startup.
    await runSync();

    // Filesystem watch → debounced sync. v4 `ignored` is a predicate over the full path.
    this.watcher = chokidar.watch(brainDir, {
      ignored: makeIgnored(brainDir),
      ignoreInitial: true,
      persistent: true,
    });
    const onFsEvent = (): void => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => void runSync(), debounceMs);
    };
    this.watcher.on("add", onFsEvent).on("change", onFsEvent).on("unlink", onFsEvent);

    // Periodic poll for inbound changes.
    this.timer = setInterval(() => void runSync(), intervalMs);
  }

  /** Tear down watcher + timers and remove the PID file. Safe to call more than once. */
  async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = undefined;
    }
    if (this.engine) {
      await removePid(this.engine.brainDir);
    }
  }
}

/** Absolute path of the daemon PID file for a brain. */
function pidPath(brainDir: string): string {
  return path.join(brainDir, COMMONS_DIR, PID_FILE);
}

/** Write the current process id to the brain's PID file. */
export async function writePid(brainDir: string): Promise<void> {
  const file = pidPath(brainDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${process.pid}\n`, "utf8");
}

/** Read the recorded PID, or null if there is no PID file. */
export async function readPid(brainDir: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(pidPath(brainDir), "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** True if a daemon PID is recorded AND that process is currently alive. */
export async function isRunning(brainDir: string): Promise<boolean> {
  const pid = await readPid(brainDir);
  if (pid === null) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't actually signal
    return true;
  } catch {
    return false; // no such process (or not permitted) → treat as not running
  }
}

/** Remove the PID file if present. */
export async function removePid(brainDir: string): Promise<void> {
  await fs.rm(pidPath(brainDir), { force: true });
}
