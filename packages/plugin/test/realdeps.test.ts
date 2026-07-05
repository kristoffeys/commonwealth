import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initBrain, listNotes } from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// The REAL production wiring — not the injected fakes the other tests use. These guard the
// two silent-failure bugs the M4b verifier caught: an unresolvable core import and a broken
// `capture --from -` invocation.
import { realDeps, realResolveBrainDir } from "../hooks/lib.mjs";

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
      JSON.stringify({ mappings: [{ prefix: path.join(homeish, "projects"), brain }] }),
    );

    // config.json at `homeish` no longer hijacks; the registry mapping resolves.
    expect(await realResolveBrainDir(project)).toBe(brain);
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
});

describe("realDeps().extractCandidates hardening (#104)", () => {
  it("hard-kills a wedged extraction child and returns [] (timeout)", async () => {
    // A `claude` stub that hangs forever: without the timeout, extractCandidates would never
    // resolve and SessionEnd would block indefinitely.
    const stub = path.join(tmp, "hang.sh");
    await fs.writeFile(stub, "#!/bin/sh\nexec sleep 600\n");
    await fs.chmod(stub, 0o755);
    const transcript = path.join(tmp, "t.jsonl");
    await fs.writeFile(transcript, `${JSON.stringify({ role: "user", content: "hi" })}\n`);

    const deps = realDeps({ claudeBin: stub, extractionTimeoutMs: 500 });
    const start = process.hrtime.bigint();
    const out = await deps.extractCandidates(transcript);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    expect(out).toEqual([]);
    expect(elapsedMs).toBeLessThan(5000); // killed at ~500ms, not left hanging
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
});

describe("realDeps().capture (real curate binary over stdin)", () => {
  // The curate binary + its deps are built once in vitest globalSetup (#111).
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
    const candidates = await deps.extractCandidates(transcriptPath);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].title).toBe("from stdin");
  });
});
