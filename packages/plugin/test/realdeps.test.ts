import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initBrain, listNotes } from "@commonwealth/core";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

describe("realResolveBrainDir (inlined registry — no bare @commonwealth/core import)", () => {
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
});

describe("realDeps().capture (real curate binary over stdin)", () => {
  beforeAll(() => {
    // Build so the spawned curate binary + its @commonwealth/core import exist.
    execFileSync("pnpm", ["-r", "build"], { cwd: repoRoot, stdio: "pipe" });
  }, 180_000);

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
});
