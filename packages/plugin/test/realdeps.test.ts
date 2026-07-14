import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initBrain, listNotes } from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The REAL production wiring — not the injected fakes the other tests use. These guard the
// two silent-failure bugs the M4b verifier caught: an unresolvable core import and a broken
// `capture --from -` invocation.
import {
  probeCurateRuntime,
  realDeps,
  realResolveBrain,
  realResolveBrainDir,
  sessionEnd,
} from "../hooks/lib.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const curateEntry = path.join(repoRoot, "packages", "curate", "dist", "index.js");

let tmp: string;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-realdeps-")));
  // Isolate from any real ~/.commonwealth: point config + registry at (missing) temp files, and
  // clear the brain-dir env so tests set it explicitly.
  process.env.COMMONWEALTH_CONFIG = path.join(tmp, "user-config.json");
  process.env.COMMONWEALTH_REGISTRY = path.join(tmp, "registry.json");
  delete process.env.COMMONWEALTH_BRAIN_DIR;
});

afterEach(async () => {
  delete process.env.COMMONWEALTH_CONFIG;
  delete process.env.COMMONWEALTH_REGISTRY;
  delete process.env.COMMONWEALTH_BRAIN_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("realResolveBrainDir (inlined registry — no bare @cmnwlth/core import)", () => {
  it("resolves a directory that is itself a brain, from a subdir", async () => {
    const brain = path.join(tmp, "acme-brain");
    await initBrain(brain);
    expect(await realResolveBrainDir(path.join(brain, "memory"))).toBe(brain);
  });

  it("honors a .commonwealth/brain marker file", async () => {
    const project = path.join(tmp, "proj");
    const brain = path.join(tmp, "elsewhere-brain");
    await fs.mkdir(brain, { recursive: true }); // marker target must exist (#68)
    await fs.mkdir(path.join(project, ".commonwealth"), { recursive: true });
    await fs.writeFile(path.join(project, ".commonwealth", "brain"), `${brain}\n`);
    expect(await realResolveBrainDir(project)).toBe(brain);
  });

  it("skips a dangling .commonwealth/brain marker and falls through (#68)", async () => {
    const project = path.join(tmp, "proj2");
    await fs.mkdir(path.join(project, ".commonwealth"), { recursive: true });
    // Marker points at a brain that does not exist → must be ignored, not returned.
    await fs.writeFile(
      path.join(project, ".commonwealth", "brain"),
      `${path.join(tmp, "ghost-brain")}\n`,
    );
    expect(await realResolveBrainDir(project)).toBeNull();
  });

  it("falls back to COMMONWEALTH_BRAIN_DIR when nothing else matches", async () => {
    const brain = path.join(tmp, "env-brain");
    process.env.COMMONWEALTH_BRAIN_DIR = brain;
    expect(await realResolveBrainDir(path.join(tmp, "plain"))).toBe(brain);
  });

  it("returns null when there is no brain, marker, registry, or env", async () => {
    expect(await realResolveBrainDir(path.join(tmp, "plain"))).toBeNull();
  });

  it("does NOT treat a dir with only .commonwealth/config.json as a brain (#74)", async () => {
    // Simulates the $HOME collision: ~/.commonwealth/config.json (the per-user scope config)
    // must not make an ancestor resolve as a brain, or it shadows the registry for every
    // project beneath it. A registry mapping under that ancestor must win.
    const homeish = path.join(tmp, "homeish");
    const project = path.join(homeish, "projects", "app");
    const brain = path.join(tmp, "real-brain");
    await fs.mkdir(path.join(homeish, ".commonwealth"), { recursive: true });
    await fs.writeFile(path.join(homeish, ".commonwealth", "config.json"), "{}\n"); // scope config
    await fs.mkdir(project, { recursive: true });
    await initBrain(brain); // a real brain (has schema-version)
    await fs.writeFile(
      process.env.COMMONWEALTH_REGISTRY as string,
      JSON.stringify({ rules: [{ prefix: path.join(homeish, "projects"), brain }] }),
    );

    // config.json at `homeish` no longer hijacks; the rule resolves.
    expect(await realResolveBrainDir(project)).toBe(brain);
  });
});

describe("realResolveBrainDir — unified ruleset in the hook (ADR-0024)", () => {
  /** Write the registry file the inlined resolver reads (COMMONWEALTH_REGISTRY). */
  async function writeRegistry(obj: unknown): Promise<void> {
    await fs.writeFile(process.env.COMMONWEALTH_REGISTRY as string, JSON.stringify(obj));
  }
  /** A git repo under tmp with an optional `origin`, so the hook's git-identity path is exercised. */
  function gitRepo(name: string, origin?: string): string {
    const repo = path.join(tmp, name);
    execFileSync("git", ["init", "-q", repo]);
    if (origin) execFileSync("git", ["-C", repo, "remote", "add", "origin", origin]);
    return repo;
  }

  it("routes a git repo by org rule to the default brain", async () => {
    const repo = gitRepo("foo", "git@github.com:weareantenna/foo.git");
    const antenna = path.join(tmp, "antenna-brain");
    await writeRegistry({ rules: [{ org: "weareantenna/*" }], defaultBrain: antenna });
    expect(await realResolveBrainDir(repo)).toBe(antenna);
  });

  it("follows a repo across sibling worktree paths — neither is registered by prefix (#182)", async () => {
    const wtA = gitRepo("app-a", "git@github.com:weareantenna/app.git");
    const wtB = gitRepo("app-b", "git@github.com:weareantenna/app.git");
    const antenna = path.join(tmp, "antenna-brain");
    await writeRegistry({ rules: [{ org: "weareantenna/*" }], defaultBrain: antenna });
    expect(await realResolveBrainDir(wtA)).toBe(antenna);
    expect(await realResolveBrainDir(wtB)).toBe(antenna);
  });

  it("a most-specific repo rule overrides the org default", async () => {
    const repo = gitRepo("erp", "git@github.com:weareantenna/erp.git");
    const antenna = path.join(tmp, "antenna-brain");
    const erp = path.join(tmp, "erp-brain");
    await writeRegistry({
      rules: [{ org: "weareantenna/*" }, { repo: "weareantenna/erp", brain: erp }],
      defaultBrain: antenna,
    });
    expect(await realResolveBrainDir(repo)).toBe(erp);
  });

  it("a deny rule yields null and does NOT fall through to the env brain", async () => {
    const work = path.join(tmp, "work");
    await fs.mkdir(work, { recursive: true });
    process.env.COMMONWEALTH_BRAIN_DIR = path.join(tmp, "env-brain");
    await writeRegistry({ rules: [{ prefix: work, deny: true }] });
    expect(await realResolveBrainDir(work)).toBeNull();
  });

  it("routes an unmatched dir via a catch-all * rule", async () => {
    const anywhere = path.join(tmp, "random");
    await fs.mkdir(anywhere, { recursive: true });
    const antenna = path.join(tmp, "antenna-brain");
    await writeRegistry({ rules: [{ prefix: "*" }], defaultBrain: antenna });
    expect(await realResolveBrainDir(anywhere)).toBe(antenna);
  });
});

describe("realResolveBrain — three-way scope result + folded allow/deny (ADR-0024 §3, retiring isInScope)", () => {
  async function writeRegistry(obj: unknown): Promise<void> {
    await fs.writeFile(process.env.COMMONWEALTH_REGISTRY as string, JSON.stringify(obj));
  }

  it("returns { kind: 'denied' } for a deny rule — the scope gate the hook now reads directly", async () => {
    const work = path.join(tmp, "work");
    await fs.mkdir(work, { recursive: true });
    await writeRegistry({ rules: [{ prefix: work, deny: true }] });
    expect(await realResolveBrain(work)).toEqual({ kind: "denied" });
  });

  it("folds a legacy `deny` entry into a deny rule → denied (personal privacy stays out of the brain)", async () => {
    const secret = path.join(tmp, "finances");
    await fs.mkdir(secret, { recursive: true });
    await writeRegistry({ deny: [secret] });
    expect(await realResolveBrain(secret)).toEqual({ kind: "denied" });
  });

  it("returns { kind: 'none' } when nothing is configured, and { kind: 'brain' } when routed", async () => {
    const loose = path.join(tmp, "loose");
    const work = path.join(tmp, "work2");
    const brain = path.join(tmp, "b");
    await fs.mkdir(loose, { recursive: true });
    await fs.mkdir(work, { recursive: true });
    await writeRegistry({ rules: [{ prefix: work, brain }] });
    expect(await realResolveBrain(loose)).toEqual({ kind: "none" });
    expect(await realResolveBrain(work)).toEqual({ kind: "brain", brain });
  });

  it("local overrides shared in the hook mirror (same matcher → the local rule wins)", async () => {
    const work = path.join(tmp, "work3");
    const mine = path.join(tmp, "mine");
    const team = path.join(tmp, "team");
    await fs.mkdir(work, { recursive: true });
    // A shared rule routes `work` → team; my LOCAL rule for the same prefix routes it → mine.
    await writeRegistry({
      rules: [
        { prefix: work, brain: team, origin: "shared", sharedFrom: team },
        { prefix: work, brain: mine },
      ],
    });
    expect(await realResolveBrain(work)).toEqual({ kind: "brain", brain: mine });
  });
});

describe("realResolveBrain — corrupt config surfaces loudly in the REAL hook path (#210)", () => {
  /** Write RAW bytes (deliberately-broken JSON) to the registry the inlined resolver reads. */
  async function writeRaw(raw: string): Promise<void> {
    await fs.writeFile(process.env.COMMONWEALTH_REGISTRY as string, raw);
  }

  it("returns corrupt-config (path + parse error) for an unparseable file — NOT none", async () => {
    const loose = path.join(tmp, "loose");
    await fs.mkdir(loose, { recursive: true });
    // The exact hand-edit that silently disabled capture: a trailing comma in `allow`.
    await writeRaw('{ "allow": ["/work"], }');

    const res = await realResolveBrain(loose);
    expect(res.kind).toBe("corrupt-config");
    expect(res.path).toBe(process.env.COMMONWEALTH_REGISTRY);
    expect(typeof res.error).toBe("string");
    expect(res.error.length).toBeGreaterThan(0);
  });

  it("treats a config that parses but is not a JSON object as corrupt (#210)", async () => {
    const loose = path.join(tmp, "loose2");
    await fs.mkdir(loose, { recursive: true });
    await writeRaw("[]");
    const res = await realResolveBrain(loose);
    expect(res.kind).toBe("corrupt-config");
    expect(res.error).toContain("must be a JSON object");
  });

  it("an explicit env pin still wins over a corrupt config", async () => {
    const brain = path.join(tmp, "env-brain");
    process.env.COMMONWEALTH_BRAIN_DIR = brain;
    await writeRaw('{ "allow": ["/work"], }');
    expect(await realResolveBrain(path.join(tmp, "loose3"))).toEqual({ kind: "brain", brain });
  });

  it("a valid marker still wins over a corrupt config", async () => {
    const project = path.join(tmp, "proj");
    const brain = path.join(tmp, "marker-brain");
    await fs.mkdir(brain, { recursive: true });
    await fs.mkdir(path.join(project, ".commonwealth"), { recursive: true });
    await fs.writeFile(path.join(project, ".commonwealth", "brain"), `${brain}\n`);
    await writeRaw('{ "allow": ["/work"], }');
    expect(await realResolveBrain(project)).toEqual({ kind: "brain", brain });
  });
});

// The bug the verifier caught: the corrupt-config receipt branch is DEAD unless the production
// resolver (realResolveBrain, wired via realDeps().resolveBrain) actually emits corrupt-config. This
// exercises the real capture entry — sessionEnd + realDeps(), no stubbed dep — end to end, and would
// have failed on the pre-fix code (which returned { kind: "none" } → the misleading "no brain" receipt).
describe("SessionEnd surfaces a corrupt config via the REAL resolver + receipt (#210)", () => {
  it("flows corrupt-config through sessionEnd to a loud receipt naming the file", async () => {
    const savedCwd = process.cwd();
    const project = path.join(tmp, "proj");
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(process.env.COMMONWEALTH_REGISTRY as string, '{ "allow": ["/work"], }');
    // Ensure the process.cwd() fallback candidate (candidateCwds) is a plain, brain-less temp dir,
    // so every candidate resolves to corrupt-config and no stray brain shadows the result.
    process.chdir(tmp);
    try {
      const deps = realDeps();
      const result = await sessionEnd(
        { cwd: project, transcript_path: path.join(tmp, "t.jsonl") },
        deps,
      );
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("corrupt-config");
      expect(result.path).toBe(process.env.COMMONWEALTH_REGISTRY);
      // Never extract/capture on a broken config — it isn't a work session.
      // The deferred receipt the NEXT SessionStart shows names the file and says it's unparseable.
      const message = await deps.takeReceipt(project);
      expect(message).toContain(process.env.COMMONWEALTH_REGISTRY as string);
      expect(message).toContain("unparseable");
    } finally {
      process.chdir(savedCwd);
    }
  });
});

describe("realDeps() receipt IO (#96) — saveReceipt / takeReceipt round-trip", () => {
  it("saves a receipt and consumes it once for the matching cwd", async () => {
    // receiptPath() derives last-session.json as a sibling of $COMMONWEALTH_CONFIG (set above).
    const deps = realDeps();
    await deps.saveReceipt({ cwd: "/work/app", message: "🧠 captured 2 note(s)", ts: 1 });

    // A non-matching cwd sees nothing and leaves the receipt in place.
    expect(await deps.takeReceipt("/somewhere/else")).toBeNull();
    // The matching cwd gets the message…
    expect(await deps.takeReceipt("/work/app")).toBe("🧠 captured 2 note(s)");
    // …and it is one-shot: a second take returns null (file consumed).
    expect(await deps.takeReceipt("/work/app")).toBeNull();
  });

  it("takeReceipt returns null when no receipt exists", async () => {
    expect(await realDeps().takeReceipt("/anything")).toBeNull();
  });

  it("prompt-capture mark round-trips per session key (#194)", async () => {
    const deps = realDeps();
    // Unseen key → null (never captured → the throttle fires on first prompt).
    expect(await deps.readCaptureMark("sess-A")).toBeNull();
    await deps.writeCaptureMark("sess-A", 1_700_000);
    expect(await deps.readCaptureMark("sess-A")).toBe(1_700_000);
    // Keys are independent (per-session throttle).
    expect(await deps.readCaptureMark("sess-B")).toBeNull();
    // A cwd-shaped key with slashes is sanitized to a safe filename, not an error.
    await deps.writeCaptureMark("/work/app", 42);
    expect(await deps.readCaptureMark("/work/app")).toBe(42);
  });
});

describe("realDeps().extractCandidates hardening (#104)", () => {
  it("hard-kills a wedged extraction child and reports a loud timeout failure", async () => {
    // A `claude` stub that hangs forever: without the timeout, extractCandidates would never
    // resolve and SessionEnd would block indefinitely.
    const stub = path.join(tmp, "hang.sh");
    await fs.writeFile(stub, "#!/bin/sh\nexec sleep 600\n");
    await fs.chmod(stub, 0o755);
    const transcript = path.join(tmp, "t.jsonl");
    await fs.writeFile(transcript, `${JSON.stringify({ role: "user", content: "hi" })}\n`);

    const deps = realDeps({ claudeBin: stub, extractionTimeoutMs: 500 });
    const start = process.hrtime.bigint();
    const out = await deps.extractCandidates({ transcriptPath: transcript, cwd: tmp });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    expect(out).toMatchObject({ ok: false, host: "claude" });
    expect(elapsedMs).toBeLessThan(5000); // killed at ~500ms, not left hanging
  });

  it("selects the requested host once and delegates the exact extraction request", async () => {
    const extract = vi.fn(async () => ({ ok: true, candidates: [] }));
    const extractorFactory = vi.fn(() => ({ extract }));
    const schemaPath = path.join(tmp, "schema.json");
    const deps = realDeps({
      host: "codex",
      codexBin: "/opt/bin/codex",
      extractionTimeoutMs: 321,
      schemaPath,
      createExtractor: extractorFactory,
    });

    expect(extractorFactory).toHaveBeenCalledOnce();
    expect(extractorFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "codex",
        codexBin: "/opt/bin/codex",
        timeoutMs: 321,
        schemaPath,
        run: expect.any(Function),
      }),
    );
    const request = { transcriptPath: "/tmp/codex-session.jsonl", cwd: "/work/app" };
    expect(await deps.extractCandidates(request)).toEqual({ ok: true, candidates: [] });
    expect(extract).toHaveBeenCalledOnce();
    expect(extract).toHaveBeenCalledWith(request);
  });
});

describe("plugin hook recursion guard (#104)", () => {
  const hooksDir = fileURLToPath(new URL("../hooks", import.meta.url));

  /** Run a hook script with the given env + stdin; resolve { code, stdout, stderr }. */
  async function runHook(
    script: string,
    env: Record<string, string>,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const { spawn } = await import("node:child_process");
    return await new Promise((resolve) => {
      const child = spawn("node", [path.join(hooksDir, script)], {
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify({ cwd: "/tmp", transcript_path: "/nope" }));
    });
  }

  it("session-end no-ops (no output) when DISABLE_HOOKS is set", async () => {
    const res = await runHook("session-end.mjs", { COMMONWEALTH_DISABLE_HOOKS: "1" });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).not.toContain("[commonwealth] session-end");
  });

  it("session-start no-ops (no stdout) when DISABLE_HOOKS is set", async () => {
    const res = await runHook("session-start.mjs", { COMMONWEALTH_DISABLE_HOOKS: "1" });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("");
  });

  it("pre-compact no-ops (no output) when DISABLE_HOOKS is set (#195)", async () => {
    const res = await runHook("pre-compact.mjs", { COMMONWEALTH_DISABLE_HOOKS: "1" });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).not.toContain("[commonwealth] pre-compact");
  });

  it("user-prompt-submit no-ops (no stdout) when DISABLE_HOOKS is set (#194)", async () => {
    const res = await runHook("user-prompt-submit.mjs", { COMMONWEALTH_DISABLE_HOOKS: "1" });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("");
  });
});

describe("PreCompact launches the capture worker (#195)", () => {
  const hooksDir = fileURLToPath(new URL("../hooks", import.meta.url));

  it("hands the pre-compaction hook JSON to the detached worker", async () => {
    // Same worker plumbing as SessionEnd: pre-compact.mjs should launch the worker (stubbed via
    // COMMONWEALTH_CAPTURE_WORKER) with the hook JSON as argv[2], then return immediately.
    const marker = path.join(tmp, "precompact-worker-ran.json");
    const stubWorker = path.join(tmp, "stub-worker.mjs");
    await fs.writeFile(
      stubWorker,
      [
        "import { promises as fs } from 'node:fs';",
        "const input = process.argv[2] ?? '';",
        `await fs.writeFile(${JSON.stringify(marker)}, input);`,
      ].join("\n"),
    );

    const { spawn } = await import("node:child_process");
    await new Promise<void>((resolve) => {
      const child = spawn("node", [path.join(hooksDir, "pre-compact.mjs")], {
        stdio: ["pipe", "ignore", "ignore"],
        env: { ...process.env, COMMONWEALTH_CAPTURE_WORKER: stubWorker },
      });
      child.on("close", () => resolve());
      child.stdin!.end(
        JSON.stringify({ cwd: "/work/x", transcript_path: "/t.jsonl", trigger: "auto" }),
      );
    });

    // Give the detached worker a moment to write its marker.
    await new Promise((r) => setTimeout(r, 800));
    const got = await fs.readFile(marker, "utf8").catch(() => null);
    expect(got, "the worker should have received the pre-compaction hook JSON").not.toBeNull();
    expect(JSON.parse(got!).trigger).toBe("auto");
  });
});

describe("UserPromptSubmit throttled capture (#194)", () => {
  const hooksDir = fileURLToPath(new URL("../hooks", import.meta.url));

  /** Run user-prompt-submit.mjs with a stub worker + the given env; resolve when it exits. */
  async function runPrompt(env: Record<string, string>): Promise<void> {
    const { spawn } = await import("node:child_process");
    await new Promise<void>((resolve) => {
      const child = spawn("node", [path.join(hooksDir, "user-prompt-submit.mjs")], {
        stdio: ["pipe", "ignore", "ignore"],
        env: { ...process.env, ...env },
      });
      child.on("close", () => resolve());
      child.stdin!.end(
        JSON.stringify({ cwd: "/work/x", prompt: "how do we sign JWTs?", session_id: "sess-1" }),
      );
    });
  }

  it("launches the detached capture worker when the throttle interval allows", async () => {
    const marker = path.join(tmp, "ups-worker-ran.json");
    const stubWorker = path.join(tmp, "stub-worker.mjs");
    await fs.writeFile(
      stubWorker,
      [
        "import { promises as fs } from 'node:fs';",
        "const input = process.argv[2] ?? '';",
        `await fs.writeFile(${JSON.stringify(marker)}, input);`,
      ].join("\n"),
    );

    // Tiny interval forces a capture on the very first prompt (no prior mark for the session).
    await runPrompt({
      COMMONWEALTH_CAPTURE_WORKER: stubWorker,
      COMMONWEALTH_PROMPT_CAPTURE_MS: "1",
    });

    await new Promise((r) => setTimeout(r, 800));
    const got = await fs.readFile(marker, "utf8").catch(() => null);
    expect(got, "the worker should have received the prompt hook JSON").not.toBeNull();
    expect(JSON.parse(got!).prompt).toBe("how do we sign JWTs?");
  });

  it("does NOT launch capture when prompt-capture is disabled (interval 0)", async () => {
    const marker = path.join(tmp, "ups-disabled-marker.json");
    const stubWorker = path.join(tmp, "stub-worker2.mjs");
    await fs.writeFile(
      stubWorker,
      [
        "import { promises as fs } from 'node:fs';",
        `await fs.writeFile(${JSON.stringify(marker)}, process.argv[2] ?? '');`,
      ].join("\n"),
    );

    await runPrompt({
      COMMONWEALTH_CAPTURE_WORKER: stubWorker,
      COMMONWEALTH_PROMPT_CAPTURE_MS: "0",
    });

    await new Promise((r) => setTimeout(r, 500));
    // Disabled → the worker must never have run.
    await expect(fs.access(marker)).rejects.toThrow();
  });
});

describe("realDeps().capture (real curate binary over stdin)", () => {
  // The curate binary + its deps are built once in vitest globalSetup (#111).
  it("probes --version through the same explicit runtime path capture uses (#222)", async () => {
    const pkg = JSON.parse(
      await fs.readFile(path.join(repoRoot, "packages", "curate", "package.json"), "utf8"),
    ) as { version: string };
    const probe = await probeCurateRuntime({ curateEntry });
    expect(probe).toMatchObject({
      kind: "entry",
      ok: true,
      code: 0,
      version: pkg.version,
    });
    expect(probe.command).toContain(curateEntry);
  });

  it("captures a candidate through the real binary (proves stdin, not --from -)", async () => {
    const brain = path.join(tmp, "brain");
    await initBrain(brain);
    const deps = realDeps({ curateEntry });

    const result = await deps.capture(brain, brain, [
      { kind: "memory", title: "Hook capture", body: "a durable fact learned this session" },
    ]);

    expect(result.captured).toBe(1);
    // autoPromote defaults on (ADR-0014), so the captured note lands straight in canon; the
    // staging queue is left empty. Asserting canon proves the full stdin → capture → promote path.
    const canon = await listNotes(brain);
    expect(canon.filter((n) => n.frontmatter.kind === "memory")).toHaveLength(1);
    const staged = await fs.readdir(path.join(brain, "staging", "memory")).catch(() => []);
    expect(staged.filter((f) => f.endsWith(".md"))).toHaveLength(0);
  });

  it("turns a non-zero curate child exit into a loud deferred failure receipt (#222)", async () => {
    const brain = path.join(tmp, "broken-runtime-brain");
    await initBrain(brain);

    // Model the corrupted npx entry from the incident: the resolved child starts, emits npm's
    // useful diagnostic, then exits 254 without stdout.
    const brokenNpx = path.join(tmp, "npx");
    await fs.writeFile(
      brokenNpx,
      "#!/usr/bin/env node\nprocess.stderr.write('package.json missing'); process.exit(254);\n",
    );
    await fs.chmod(brokenNpx, 0o755);
    const deps = realDeps({
      curateEntry: null, // force the fallback even though globalSetup built local vendor/
      curatePackage: "@cmnwlth/curate@0.1.12",
      npxBin: brokenNpx,
    });
    const result = await deps.capture(brain, brain, [
      { kind: "memory", title: "Would be lost", body: "must produce a failure receipt" },
    ]);

    expect(result).toMatchObject({
      captured: 0,
      failed: true,
      reason: "curate-runtime",
      code: 254,
      error: "package.json missing",
    });
    expect(result.runtime).toContain("@cmnwlth/curate@0.1.12");
    expect(result.notes).toBeUndefined();

    // Drive the result through the real SessionEnd receipt path (candidate extraction is injected
    // here only to isolate the broken curate child from the unrelated Claude extractor).
    const saved: Array<{ message: string }> = [];
    const endDeps = {
      resolveBrain: async () => ({ kind: "brain", brain }),
      extractCandidates: async () => ({
        ok: true,
        candidates: [
          { kind: "memory", title: "Would be lost", body: "must produce a failure receipt" },
        ],
      }),
      capture: deps.capture,
      refreshStatus: async () => {},
      saveReceipt: async (receipt: { message: string }) => saved.push(receipt),
    };
    const end = await sessionEnd({ cwd: brain, transcript_path: "/unused" }, endDeps);
    expect(end).toMatchObject({ failed: true, reason: "curate-runtime", code: 254 });
    expect(saved[0]?.message).toContain("capture FAILED");
    expect(saved[0]?.message).not.toContain("no durable knowledge");
  });

  it("extracts from a multi-MB transcript without E2BIG — transcript goes on stdin, not argv (#84)", async () => {
    // A transcript larger than ARG_MAX (~1MB): if it were passed as a `claude -p` argv element
    // the spawn throws E2BIG and extraction silently returns []. Piping it on stdin must work.
    const transcriptPath = path.join(tmp, "transcript.jsonl");
    const bigLine = JSON.stringify({ role: "user", content: "x".repeat(2000) }) + "\n";
    await fs.writeFile(transcriptPath, bigLine.repeat(1600)); // ~3.3 MB, > ARG_MAX

    // Stub `claude`: read stdin, and only emit a candidate if the transcript actually arrived
    // there (proving stdin delivery). If argv were used, the spawn would have E2BIG'd instead.
    const stub = path.join(tmp, "claude-stub.mjs");
    await fs.writeFile(
      stub,
      [
        "let s = '';",
        "process.stdin.on('data', (d) => (s += d));",
        "process.stdin.on('end', () => {",
        "  const got = s.length > 1_000_000;",
        "  process.stdout.write(got ? JSON.stringify([{kind:'memory',title:'from stdin',body:'the transcript arrived on stdin, no E2BIG'}]) : '[]');",
        "});",
      ].join("\n"),
    );
    const stubBin = path.join(tmp, "claude-stub.sh");
    await fs.writeFile(stubBin, `#!/bin/sh\nexec "${process.execPath}" "${stub}"\n`);
    await fs.chmod(stubBin, 0o755);

    const deps = realDeps({ claudeBin: stubBin });
    const extracted = await deps.extractCandidates({ transcriptPath, cwd: tmp });

    expect(extracted.ok).toBe(true);
    expect(extracted.candidates).toHaveLength(1);
    expect(extracted.candidates[0].title).toBe("from stdin");
  });
});

describe("SessionEnd detached capture worker (#190 — survives `/clear` teardown)", () => {
  const hooksDir = fileURLToPath(new URL("../hooks", import.meta.url));

  // The core of the #190 fix: on `/clear`, Claude Code fires SessionEnd fire-and-forget, then
  // tears the session down at once. If capture ran as an ordinary child of the hook, that teardown
  // (a signal to the hook's process group) would kill it mid-extraction — every `/clear` captured
  // nothing. session-end.mjs now launches the worker DETACHED (its own process group via setsid),
  // so a group-kill of the launcher can't reach it. This test proves exactly that: it kills the
  // launcher's entire process group and asserts the worker still ran to completion.
  it("finishes its work after the launcher's process group is killed", async () => {
    const marker = path.join(tmp, "worker-ran.json");
    // Stub worker: wait long enough that it is still running when we kill the launcher's group,
    // then record the hook JSON it was handed on argv[2]. Proves both survival and arg delivery.
    const stubWorker = path.join(tmp, "stub-worker.mjs");
    await fs.writeFile(
      stubWorker,
      [
        "import { promises as fs } from 'node:fs';",
        "const input = process.argv[2] ?? '';",
        "await new Promise((r) => setTimeout(r, 800));",
        `await fs.writeFile(${JSON.stringify(marker)}, input);`,
      ].join("\n"),
    );

    const { spawn } = await import("node:child_process");
    // Launch the REAL session-end.mjs as its own process-group leader (detached) so `-pid` targets
    // the whole group. COMMONWEALTH_CAPTURE_WORKER swaps in the fast stub for the real LLM pipeline.
    const launcher = spawn("node", [path.join(hooksDir, "session-end.mjs")], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env, COMMONWEALTH_CAPTURE_WORKER: stubWorker },
    });
    const pgid = launcher.pid!;
    launcher.stdin!.end(
      JSON.stringify({ cwd: "/work/x", transcript_path: "/t.jsonl", reason: "clear" }),
    );

    // The launcher must return immediately (it only spawns the worker and exits).
    await new Promise<void>((resolve) => launcher.on("close", () => resolve()));

    // Simulate `/clear`: SIGKILL the launcher's ENTIRE process group. A worker in the SAME group
    // (the pre-fix behavior) would die here; the detached worker (own group) survives.
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // ESRCH: the group is already empty because the worker is NOT in it — exactly the fix.
    }

    // Give the detached worker time to finish its wait + write.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const got = await fs.readFile(marker, "utf8").catch(() => null);
    expect(
      got,
      "detached worker should have written its marker despite the group kill",
    ).not.toBeNull();
    expect(JSON.parse(got!).reason).toBe("clear");
  });
});
