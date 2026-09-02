import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireSyncLock, initBrain, setFeature, writeNote } from "@cmnwlth/core";
import { SyncEngine } from "@cmnwlth/sync";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";
import { createMcpSync, resolveSyncOwner, type McpSync } from "../src/sync.js";

/**
 * MCP-only sync (#290, ADR-0040). The bug this file exists to pin down: on a host without our
 * lifecycle hooks, a note written through `remember` was left as an UNTRACKED working-tree file
 * while the tool answered "remembered" — so it never reached a teammate. Every assertion here is
 * therefore about git state (tracked / pushed / pullable by a second clone), not just file
 * existence, and about whether the tool told the truth when publishing could not happen.
 */

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
}

function setIdentity(dir: string): void {
  git(dir, ["config", "user.email", "mcp-host@example.com"]);
  git(dir, ["config", "user.name", "MCP Host"]);
}

interface Fixture {
  /** Root temp dir holding everything. */
  root: string;
  /** Bare remote standing in for the team's shared brain. */
  remote: string;
  /** The hookless host's working copy. */
  brain: string;
}

/** A bare remote plus one clone with an initialized, pushed brain. */
async function makeFixture(): Promise<Fixture> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-mcp-sync-")),
  );
  const remote = path.join(root, "remote.git");
  const brain = path.join(root, "brain");
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "pipe" });
  execFileSync("git", ["clone", "-q", remote, brain], { stdio: "pipe" });
  setIdentity(brain);
  await initBrain(brain, { name: "test-brain" });
  git(brain, ["add", "-A"]);
  git(brain, ["commit", "-qm", "init brain"]);
  git(brain, ["push", "-u", "origin", "main"]);
  return { root, remote, brain };
}

/** Clone the remote afresh — "can a teammate actually see it?" with no shortcuts. */
function teammateClone(fx: Fixture, name: string): string {
  const dir = path.join(fx.root, name);
  execFileSync("git", ["clone", "-q", fx.remote, dir], { stdio: "pipe" });
  return dir;
}

interface RememberOutcome {
  text: string;
  structured: { status?: string; path?: string; sync?: { status: string; published: boolean } };
}

/**
 * Drive `remember` over a real MCP client/server pair, exactly as a bare MCP host would. Going
 * through the wire (not the pure handler) is deliberate: the publish step lives in the server's
 * tool wiring, and its honest-reporting text is what the user actually sees.
 */
async function rememberVia(
  brainDir: string,
  sync: McpSync | null,
  args: { title: string; body: string },
): Promise<RememberOutcome> {
  const server = createServer(brainDir, { kind: "none" }, "test-brain", sync);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const res = await client.callTool({
      name: "remember",
      arguments: { kind: "memory", ...args },
    });
    expect(res.isError).toBeFalsy();
    return {
      text: (res.content as { type: string; text: string }[])[0]!.text,
      structured: res.structuredContent as RememberOutcome["structured"],
    };
  } finally {
    await client.close();
    await server.close();
  }
}

/** Fast lock-retry budget: these tests assert the deferral, not the wall-clock backoff. */
const FAST_RETRY = { attempts: 2, backoffMs: 1 };

let fx: Fixture;

beforeEach(async () => {
  vi.stubEnv("COMMONWEALTH_AUTHOR", "Test Contributor");
  vi.stubEnv("COMMONWEALTH_AUTHOR_EMAIL", "contributor@example.com");
  fx = await makeFixture();
  // The engine materializes a brain's shared rules into the per-user config; redirect it at a
  // temp file so no test ever touches the real ~/.commonwealth/config.json.
  vi.stubEnv("COMMONWEALTH_CONFIG", path.join(fx.root, "user-config.json"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(fx.root, { recursive: true, force: true });
});

describe("resolveSyncOwner", () => {
  it("defaults to the SERVER owning sync, so an unknown host publishes rather than silently drops", () => {
    expect(resolveSyncOwner({})).toBe("server");
    expect(resolveSyncOwner({ COMMONWEALTH_MCP_SYNC: "" })).toBe("server");
    expect(resolveSyncOwner({ COMMONWEALTH_MCP_SYNC: "   " })).toBe("server");
  });

  it("hands sync to the host only on an explicit opt-out (what packages/plugin/.mcp.json sets)", () => {
    for (const v of ["off", "OFF", "0", "false", "host"]) {
      expect(resolveSyncOwner({ COMMONWEALTH_MCP_SYNC: v })).toBe("host");
    }
  });

  it("treats anything unrecognized as server-owned — an unparseable value must not disable publishing", () => {
    for (const v of ["on", "1", "true", "server", "yes-please"]) {
      expect(resolveSyncOwner({ COMMONWEALTH_MCP_SYNC: v })).toBe("server");
    }
  });
});

describe("remember on a hookless host (#290)", () => {
  it("commits the note and pushes it, so a teammate's fresh clone actually has it", async () => {
    const sync = createMcpSync(fx.brain, { retry: FAST_RETRY });
    const { text, structured } = await rememberVia(fx.brain, sync, {
      title: "Invoices round half-up",
      body: "Billing rounds half-up, not half-even.",
    });

    expect(structured.status).toBe("promoted");
    expect(structured.sync).toEqual({ status: "synced", published: true });
    expect(text).toContain("pushed to the shared remote");

    // The actual regression: nothing is left dangling in the working tree.
    expect(git(fx.brain, ["status", "--porcelain"])).toBe("");
    // …and the note is a TRACKED file, not an untracked one that merely exists.
    expect(git(fx.brain, ["ls-files", structured.path!])).toBe(structured.path);
    // …and it reached the remote: a teammate cloning right now sees it.
    const bob = teammateClone(fx, "bob");
    await expect(fs.access(path.join(bob, structured.path!))).resolves.toBeUndefined();
  });

  it("pulls a teammate's note at startup instead of serving a stale working copy", async () => {
    // Bob writes and pushes; our host's clone knows nothing about it yet.
    const bob = teammateClone(fx, "bob");
    setIdentity(bob);
    const bobsNote = await writeNote(bob, {
      kind: "memory",
      title: "Bob's fact",
      body: "Bob knows.",
    });
    git(bob, ["add", "-A"]);
    git(bob, ["commit", "-qm", "bob: a fact"]);
    git(bob, ["push", "-q", "origin", "main"]);

    const before = path.join(fx.brain, bobsNote.path);
    await expect(fs.access(before)).rejects.toThrow();

    const outcome = await createMcpSync(fx.brain, { retry: FAST_RETRY }).pullOnStart();
    expect(outcome.status).toBe("synced");
    await expect(fs.access(before)).resolves.toBeUndefined();
  });

  it("leaves the write path untouched when the host owns sync (the opt-out Claude Code uses)", async () => {
    // `null` is what createServer gets when COMMONWEALTH_MCP_SYNC=off resolves to `host`.
    expect(resolveSyncOwner({ COMMONWEALTH_MCP_SYNC: "off" })).toBe("host");
    const { text, structured } = await rememberVia(fx.brain, null, {
      title: "Deploys happen on Fridays",
      body: "We ship at the end of the week.",
    });

    expect(structured.status).toBe("promoted");
    // No sync field, no publish sentence: byte-identical to the pre-ADR-0040 response.
    expect(structured.sync).toBeUndefined();
    expect(text).toBe(
      `Remembered "Deploys happen on Fridays" as ${structured.path?.split("/").pop()?.replace(/\.md$/, "")} (${structured.path}).`,
    );
    // And the pre-existing behaviour the hooks then clean up: the note is untracked, uncommitted.
    expect(git(fx.brain, ["status", "--porcelain"])).toContain("?? ");
    expect(git(fx.brain, ["ls-files", structured.path!])).toBe("");
  });
});

describe("publish failures degrade gracefully, never silently", () => {
  it("keeps the note (committed locally) and says publishing FAILED when the remote is unreachable", async () => {
    git(fx.brain, ["remote", "set-url", "origin", path.join(fx.root, "does-not-exist.git")]);
    const sync = createMcpSync(fx.brain, { retry: FAST_RETRY });
    const { text, structured } = await rememberVia(fx.brain, sync, {
      title: "Offline fact stays local",
      body: "The remote is gone, the note must not be.",
    });

    expect(structured.status).toBe("promoted");
    expect(structured.sync).toMatchObject({ status: "failed", published: false });
    expect(text).toContain("publishing FAILED");
    // The note survived — and it is COMMITTED, so the next successful sync pushes it.
    await expect(fs.access(path.join(fx.brain, structured.path!))).resolves.toBeUndefined();
    expect(git(fx.brain, ["ls-files", structured.path!])).toBe(structured.path);
  });

  it("says a remote-less brain published nothing rather than implying it shipped", async () => {
    const solo = path.join(fx.root, "solo");
    await fs.mkdir(solo, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", solo], { stdio: "pipe" });
    setIdentity(solo);
    await initBrain(solo, { name: "solo-brain" });

    const { text, structured } = await rememberVia(
      solo,
      createMcpSync(solo, { retry: FAST_RETRY }),
      {
        title: "Local-only brain fact",
        body: "There is no remote here.",
      },
    );
    expect(structured.sync).toMatchObject({ status: "synced", published: false });
    expect(text).toContain("no git remote");
    expect(git(solo, ["ls-files", structured.path!])).toBe(structured.path);
  });

  it("stops waiting on a wedged pass at the cap instead of hanging the tool call", async () => {
    const wedged = { syncOnce: () => new Promise<never>(() => {}) } as unknown as SyncEngine;
    const outcome = await createMcpSync(fx.brain, {
      engine: wedged,
      publishTimeoutMs: 25,
    }).publish();
    expect(outcome).toEqual({ status: "timed-out", ms: 25 });
  });

  it("tells the user the review queue never syncs, so 'staged' cannot read as 'shared'", async () => {
    await setFeature(fx.brain, "autoPromote", false);
    const { text, structured } = await rememberVia(
      fx.brain,
      createMcpSync(fx.brain, { retry: FAST_RETRY }),
      { title: "Held for review", body: "This waits in the staging queue for approval." },
    );
    expect(structured.status).toBe("staged");
    expect(text).toContain("never synced");
    // Staging is gitignored per ADR-0008 — no pass was run, and nothing claims a publish.
    expect(structured.sync).toBeUndefined();
  });
});

describe("concurrency with a hook-driven sync (ADR-0032 + ADR-0040)", () => {
  it("defers while a concurrent hook sync holds the lock, and the note lands on the next pass", async () => {
    // Simulate the Claude Code hook's `commonwealth-sync sync` process owning the brain.
    const release = await acquireSyncLock(fx.brain);
    expect(release).not.toBeNull();

    const { text, structured } = await rememberVia(
      fx.brain,
      createMcpSync(fx.brain, { retry: FAST_RETRY }),
      { title: "Deferred while the lock is held", body: "Another sync owns the repo right now." },
    );
    expect(structured.sync).toMatchObject({ status: "deferred", published: false });
    expect(text).toContain("NOT yet published");
    // Nothing is lost: the note is on disk, waiting for a pass.
    expect(git(fx.brain, ["ls-files", structured.path!])).toBe("");

    // The lock holder finishes and syncs — which flushes our note too.
    await release!();
    const summary = await new SyncEngine(fx.brain).syncOnce();
    expect(summary.pushed).toBe(true);
    const bob = teammateClone(fx, "bob");
    await expect(fs.access(path.join(bob, structured.path!))).resolves.toBeUndefined();
  });

  it("runs simultaneously with a hook sync without corrupting the repo or deadlocking", async () => {
    // A note the hook's capture worker wrote, alongside the one the MCP server is about to write.
    const hookNote = (
      await writeNote(fx.brain, { kind: "memory", title: "Hook captured", body: "From the hook." })
    ).path;

    // Two ENGINES, so only the cross-process file lock orders them (a shared SerialQueue would
    // make this turn-taking rather than a real race), fired with genuine Promise.all concurrency.
    const mcp = createMcpSync(fx.brain, { retry: FAST_RETRY });
    const hookEngine = new SyncEngine(fx.brain);
    const [mcpOutcome, hookSummary] = await Promise.all([
      rememberVia(fx.brain, mcp, {
        title: "Written during a concurrent sync",
        body: "Two syncers, one brain.",
      }),
      hookEngine.syncOnce(),
    ]);

    // Whichever lost the lock race is reported honestly rather than pretending to have shipped.
    expect(["synced", "deferred"]).toContain(mcpOutcome.structured.sync?.status);
    expect(typeof hookSummary.skippedLocked).toBe("boolean");

    // One more pass (the "next sync" every deferral promises) must converge everything.
    await new SyncEngine(fx.brain).syncOnce();
    expect(git(fx.brain, ["status", "--porcelain"])).toBe("");
    const bob = teammateClone(fx, "bob");
    for (const rel of [hookNote, mcpOutcome.structured.path!]) {
      const body = await fs.readFile(path.join(bob, rel), "utf8");
      expect(body).not.toContain("<<<<<<<");
      expect(body).not.toContain(">>>>>>>");
    }
  });
});
