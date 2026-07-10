import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end guard: run the *built* binary (not source) and confirm it starts. This is
 * the only test that catches a broken dist entry point (e.g. a duplicate shebang), which
 * source-imported unit tests miss.
 */

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const distEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

let brainDir: string;

beforeAll(async () => {
  // Build core + curate so the dist entry (and its @cmnwlth/core import) exist.
  execFileSync("pnpm", ["-r", "build"], { cwd: repoRoot, stdio: "pipe" });
  brainDir = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-curate-smoke-"));
}, 120_000);

afterAll(async () => {
  if (brainDir) await fs.rm(brainDir, { recursive: true, force: true });
});

describe("built binary", () => {
  it("runs `list` against an empty brain with exit 0", () => {
    const out = execFileSync("node", [distEntry, "list", "--dir", brainDir], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    // Empty brain: no pending notes, no output rows.
    expect(out.toString().trim()).toBe("");
  });

  it("has exactly one shebang at the top of dist/index.js", async () => {
    const contents = await fs.readFile(distEntry, "utf8");
    const shebangs = contents.split("\n").filter((line) => line.startsWith("#!"));
    expect(shebangs).toHaveLength(1);
    expect(contents.startsWith("#!")).toBe(true);
  });

  it("capture --force stages even when the cwd is out of scope (explicit import)", async () => {
    // Non-empty allow that does NOT cover the cwd → the cwd is out of scope.
    const configPath = path.join(brainDir, "force-config.json");
    await fs.writeFile(configPath, JSON.stringify({ allow: ["/nowhere"], deny: [] }));
    const candidate = JSON.stringify([
      { kind: "memory", title: "Forced import", body: "a durable fact imported via seeding" },
    ]);
    const env = { ...process.env, COMMONWEALTH_CONFIG: configPath };

    // Without --force: out of scope → nothing staged.
    const off = execFileSync("node", [distEntry, "capture", "--dir", brainDir], {
      cwd: repoRoot,
      input: candidate,
      env,
      stdio: "pipe",
    });
    expect(off.toString().trim()).toBe("");

    // With --force: scope bypassed → one note staged.
    const on = execFileSync("node", [distEntry, "capture", "--dir", brainDir, "--force"], {
      cwd: repoRoot,
      input: candidate,
      env,
      stdio: "pipe",
    });
    expect(on.toString()).toContain("Forced import");
  });

  it("reports scope check for a cwd (exit 0, prints in/out-scope)", async () => {
    // Scope IS resolution now (ADR-0024 §3): in scope ⟺ the cwd resolves to a brain. A rule routing
    // the cwd → a brain makes it in-scope; an empty config (nothing configured) is out-of-scope.
    const configPath = path.join(brainDir, "config.json");
    const scopeCheck = (env: NodeJS.ProcessEnv): string =>
      execFileSync("node", [distEntry, "scope", "check", "--cwd", brainDir], {
        cwd: repoRoot,
        stdio: "pipe",
        env,
      })
        .toString()
        .trim();

    await fs.writeFile(
      configPath,
      JSON.stringify({ rules: [{ prefix: brainDir, brain: brainDir }] }),
    );
    expect(scopeCheck({ ...process.env, COMMONWEALTH_CONFIG: configPath })).toBe("in-scope");

    // An empty/absent config maps the cwd to nothing → out of scope.
    const emptyConfig = path.join(brainDir, "empty-config.json");
    expect(scopeCheck({ ...process.env, COMMONWEALTH_CONFIG: emptyConfig })).toBe("out-of-scope");
  });

  it("resolves the brain via the registry when run without --dir from a mapped cwd (#69)", async () => {
    // realpath: on macOS `/var` → `/private/var`, and the resolver compares resolved (not
    // symlink-followed) paths, so the registry prefix must match the cwd the process reports.
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-curate-reg-")),
    );
    const brain = path.join(root, "team-brain");
    const project = path.join(root, "work", "app");
    await fs.mkdir(project, { recursive: true });
    const registry = path.join(root, "registry.json");
    await fs.writeFile(
      registry,
      JSON.stringify({ rules: [{ prefix: path.join(root, "work"), brain }] }),
    );
    // Override the registry; ensure no explicit brain env leaks in from the outer process.
    const env = { ...process.env, COMMONWEALTH_REGISTRY: registry };
    delete env.COMMONWEALTH_BRAIN_DIR;

    // Stage a note into the brain explicitly, so `list` has something to find.
    execFileSync(
      "node",
      // prettier-ignore
      [distEntry, "stage", "--dir", brain, "--kind", "memory", "--title", "Registry-resolved fact", "--body", "proves the CLI hit the mapped brain, not the cwd"],
      { cwd: repoRoot, env, stdio: "pipe" },
    );

    // From the mapped project dir, `list` with NO --dir must resolve the brain via the registry.
    const out = execFileSync("node", [distEntry, "list"], {
      cwd: project,
      env,
      stdio: "pipe",
    }).toString();
    expect(out).toContain("Registry-resolved fact");

    await fs.rm(root, { recursive: true, force: true });
  });

  it("`scope allow` warns when the path maps to no brain, and stays quiet when mapped (#157)", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-curate-allowwarn-")),
    );
    const unmapped = path.join(root, "personal", "proj");
    const mapped = path.join(root, "work", "app");
    await fs.mkdir(unmapped, { recursive: true });
    await fs.mkdir(mapped, { recursive: true });
    const registry = path.join(root, "registry.json");
    await fs.writeFile(
      registry,
      JSON.stringify({
        rules: [{ prefix: path.join(root, "work"), brain: path.join(root, "brain") }],
      }),
    );
    const env = {
      ...process.env,
      COMMONWEALTH_CONFIG: path.join(root, "config.json"),
      COMMONWEALTH_REGISTRY: registry,
    };
    delete env.COMMONWEALTH_BRAIN_DIR;

    // Allowed-but-unmapped: succeed (the allow IS recorded) but warn that capture stays inert.
    const warn = spawnSync("node", [distEntry, "scope", "allow", unmapped], {
      env,
      encoding: "utf8",
    });
    expect(warn.status).toBe(0);
    expect(warn.stderr).toContain("WARNING");
    expect(warn.stderr).toContain("commonwealth add");

    // A path the registry already maps produces no warning.
    const quiet = spawnSync("node", [distEntry, "scope", "allow", mapped], {
      env,
      encoding: "utf8",
    });
    expect(quiet.status).toBe(0);
    expect(quiet.stderr).not.toContain("WARNING");

    await fs.rm(root, { recursive: true, force: true });
  });

  it("errors clearly (exit 1) when no brain is configured for the cwd (#69)", async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-curate-nobrain-"));
    const env = { ...process.env, COMMONWEALTH_REGISTRY: path.join(plain, "registry.json") };
    delete env.COMMONWEALTH_BRAIN_DIR;

    let stderr = "";
    let failed = false;
    try {
      execFileSync("node", [distEntry, "list"], { cwd: plain, env, stdio: "pipe" });
    } catch (err) {
      failed = true;
      stderr = String((err as { stderr?: Buffer }).stderr ?? "");
    }
    expect(failed).toBe(true);
    expect(stderr).toContain("no Commonwealth brain configured");

    await fs.rm(plain, { recursive: true, force: true });
  });
});
