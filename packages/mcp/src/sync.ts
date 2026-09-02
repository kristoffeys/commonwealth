import {
  SyncEngine,
  syncOnceWithRetry,
  type SyncRetryOptions,
  type SyncSummary,
} from "@cmnwlth/sync";

/**
 * MCP-only sync (#290, ADR-0040): make the SERVER publish its own writes when the host does not.
 *
 * ADR-0032 folded sync into the session lifecycle hooks, which is complete for Claude Code and
 * Codex — they run our hooks. It is a silent data-loss bug everywhere else: a note written through
 * the `remember` tool from Claude Desktop's Chat tab or any bare MCP client was created as an
 * untracked working-tree file that never reached a teammate, while the tool answered "remembered".
 *
 * The engine is NOT reimplemented here: this module drives `@cmnwlth/sync`'s `syncOnce` in-process
 * (one shared {@link SyncEngine}, so its `SerialQueue` orders our own passes and its cross-process
 * `sync.lock` orders us against a concurrent hook sync). There is no timer, no watcher, and no
 * long-lived state — the two triggers are "the server started" and "a note just landed in canon",
 * which is exactly the lifecycle shape ADR-0032 chose, moved to a host that has no lifecycle.
 */

/** The env var that hands sync ownership to the host. See {@link resolveSyncOwner}. */
export const SYNC_OWNER_ENV = "COMMONWEALTH_MCP_SYNC";

/**
 * Who publishes this server's writes: `server` (this module runs `syncOnce`) or `host` (stand down
 * — the host's lifecycle hooks already sync, per ADR-0032).
 */
export type SyncOwner = "server" | "host";

/**
 * Resolve sync ownership from the environment, defaulting to `server`.
 *
 * The default is the whole point (ADR-0040): an UNKNOWN host fails toward publishing. Our own
 * plugin — the one host we know runs the lifecycle hooks — opts out explicitly in
 * `packages/plugin/.mcp.json`, so Claude Code and Codex behaviour is unchanged. Getting it wrong in
 * the `host` direction loses a teammate's note silently; getting it wrong in the `server` direction
 * costs one redundant, lock-serialized, idempotent git pass. Only one of those is a bug.
 */
export function resolveSyncOwner(env: NodeJS.ProcessEnv = process.env): SyncOwner {
  const raw = env[SYNC_OWNER_ENV]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return "server";
  return raw === "off" || raw === "0" || raw === "false" || raw === "host" ? "host" : "server";
}

/** Outcome of one sync pass driven by this module. */
export type SyncOutcome =
  /** The pass ran to completion. Read {@link SyncSummary.pushed} for whether anything shipped. */
  | { status: "synced"; summary: SyncSummary }
  /** A live peer (a concurrent hook sync, or the opt-in daemon) held the lock; nothing was done. */
  | { status: "deferred"; summary: SyncSummary }
  /** The time budget ran out. The pass itself continues detached — it is a git process, not a lie. */
  | { status: "timed-out"; ms: number }
  /** git refused: offline, no credentials, no remote access, a rejected push. */
  | { status: "failed"; error: string };

/** Time budget for the pull at startup — ADR-0032 §3's SessionStart cap, same reasoning. */
export const DEFAULT_PULL_TIMEOUT_MS = 5_000;

/**
 * Time budget for the publish pass on the write path. Longer than the startup cap because a user
 * is waiting on a truthful answer to "did this reach my team?", and a first push over SSH on a cold
 * connection is not fast. Still bounded: a wedged remote must never hang the tool call.
 */
export const DEFAULT_PUBLISH_TIMEOUT_MS = 20_000;

/** Options for {@link createMcpSync}; all defaulted, all overridable by tests. */
export interface McpSyncOptions {
  /** Cap for {@link McpSync.pullOnStart} (default {@link DEFAULT_PULL_TIMEOUT_MS}). */
  pullTimeoutMs?: number;
  /** Cap for {@link McpSync.publish} (default {@link DEFAULT_PUBLISH_TIMEOUT_MS}). */
  publishTimeoutMs?: number;
  /** Lock-contention retry policy passed to `syncOnceWithRetry` (ADR-0032's bounded backoff). */
  retry?: SyncRetryOptions;
  /** Engine to drive; one is created for `brainDir` when omitted. Shared across passes. */
  engine?: SyncEngine;
}

/** The two sync triggers a hookless host gets: server start, and a note landing in canon. */
export interface McpSync {
  /** The brain being synced. */
  readonly brainDir: string;
  /** Pull teammates' notes before serving reads. Bounded and fail-open (never throws). */
  pullOnStart(): Promise<SyncOutcome>;
  /** Commit + push a just-promoted note. Bounded and fail-open (never throws). */
  publish(): Promise<SyncOutcome>;
}

/**
 * Race `work` against `ms`. On timeout the underlying pass is NOT cancelled (you cannot cancel a
 * git child process honestly) — it keeps running detached, so the work still lands; we just stop
 * waiting and say so. The stray promise gets a `catch` so a later failure can't crash the server
 * with an unhandled rejection, and the timer is unref'd so it can never hold the process open.
 */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | { timedOut: true }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
    timer.unref();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Build the sync driver for `brainDir`. One {@link SyncEngine} is shared by every pass, so
 * `pullOnStart` and `publish` are serialized in-process by the engine's `SerialQueue` and against
 * other processes by the `sync.lock` — a startup pull and a `remember` arriving together queue,
 * they do not race (ADR-0003's union-merge is what makes the uncoordinated push safe).
 */
export function createMcpSync(brainDir: string, opts: McpSyncOptions = {}): McpSync {
  const engine = opts.engine ?? new SyncEngine(brainDir);
  const retry = opts.retry;

  /** One bounded, fail-open pass. Never throws: every failure becomes a reportable outcome. */
  const run = async (timeoutMs: number): Promise<SyncOutcome> => {
    const pass = syncOnceWithRetry(engine, retry ?? {});
    // Swallow a post-timeout rejection: by then we've already reported, and an unhandled
    // rejection would take the whole server down over a failed background push.
    pass.catch(() => undefined);
    let raced;
    try {
      raced = await withTimeout(pass, timeoutMs);
    } catch (err) {
      return { status: "failed", error: (err as Error).message };
    }
    if ("timedOut" in raced) return { status: "timed-out", ms: timeoutMs };
    const { summary } = raced;
    return summary.skippedLocked ? { status: "deferred", summary } : { status: "synced", summary };
  };

  return {
    brainDir,
    pullOnStart: () => run(opts.pullTimeoutMs ?? DEFAULT_PULL_TIMEOUT_MS),
    publish: () => run(opts.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS),
  };
}

/**
 * The honest one-line verdict on a just-written note, for the `remember` tool's human text.
 *
 * "Remembered" must never imply "published" when it wasn't — that conflation IS the bug (#290). So
 * every branch says plainly whether the note reached the remote, and an unpublished note always
 * says what happens next. A withheld secret is named too: a silently-dropped note is a trust
 * problem (CLAUDE.md principle 4), and it stays in the working tree for the user to fix.
 */
export function describePublish(outcome: SyncOutcome): string {
  switch (outcome.status) {
    case "synced": {
      const { summary } = outcome;
      const withheld =
        summary.secretsBlocked.length > 0
          ? ` Withheld from the commit for containing a secret: ${summary.secretsBlocked.join(", ")} — fix and re-sync.`
          : "";
      if (summary.pushed) return `Committed and pushed to the shared remote.${withheld}`;
      if (!summary.pulled) {
        return (
          `Committed locally, but NOT published: this brain has no git remote, so nothing was ` +
          `shared. Add one (\`git remote add origin …\`) to make it multiplayer.${withheld}`
        );
      }
      return (
        `Committed locally; nothing was pushed (the branch was already up to date with the ` +
        `remote).${withheld}`
      );
    }
    case "deferred":
      return (
        "Written locally, NOT yet published: another sync pass holds this brain's lock. It will " +
        "be committed and pushed by that pass or by the next sync — nothing is lost."
      );
    case "timed-out":
      return (
        `Written locally; publishing did not finish within ${outcome.ms}ms and is still running in ` +
        `the background. Run \`commonwealth sync\` if it needs to be shared now.`
      );
    case "failed":
      return (
        `Written locally, but publishing FAILED: ${outcome.error}. The note is safe on disk and ` +
        `the next sync will retry — but your team cannot see it yet.`
      );
  }
}

/** Stderr diagnostic for a pass, used at startup where there is no client-visible surface. */
export function formatOutcome(label: string, outcome: SyncOutcome): string {
  switch (outcome.status) {
    case "synced":
      return (
        `[commonwealth-mcp] ${label}: committed=${outcome.summary.committed} ` +
        `pulled=${outcome.summary.pulled} pushed=${outcome.summary.pushed} ` +
        `conflicts=${outcome.summary.conflicts.length}`
      );
    case "deferred":
      return `[commonwealth-mcp] ${label}: deferred (another sync holds the lock)`;
    case "timed-out":
      return `[commonwealth-mcp] ${label}: exceeded ${outcome.ms}ms — continuing in the background, serving possibly-stale notes`;
    case "failed":
      return `[commonwealth-mcp] ${label}: failed (${outcome.error}) — serving local notes only`;
  }
}
