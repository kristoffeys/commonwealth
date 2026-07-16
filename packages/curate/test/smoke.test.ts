import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initBrain, listNotes, readNote, writeNote } from "@cmnwlth/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listPending } from "../src/review.js";

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
  it("prints its package version without requiring a brain (#222)", async () => {
    const pkg = JSON.parse(
      await fs.readFile(path.join(repoRoot, "packages", "curate", "package.json"), "utf8"),
    ) as { version: string };
    const out = execFileSync("node", [distEntry, "--version"], { cwd: repoRoot, stdio: "pipe" });
    expect(out.toString().trim()).toBe(pkg.version);
  });

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

  it("capture --force imports even when the cwd is out of scope without attribution", async () => {
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
    expect(await listNotes(brainDir, "person")).toHaveLength(0);
    const forced = (await listNotes(brainDir, "memory")).find(
      (note) => note.frontmatter.title === "Forced import",
    )!;
    expect(forced.frontmatter.author).toBeUndefined();
    expect(forced.frontmatter.author_ref).toBeUndefined();
    expect(forced.frontmatter.relates).toEqual([]);
  });

  it("attributes hook-facing capture to a stable person", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-curate-attribution-")),
    );
    const brain = path.join(root, "brain");
    const project = path.join(root, "project");
    await fs.mkdir(project, { recursive: true });
    const configPath = path.join(root, "config.json");
    await fs.writeFile(configPath, JSON.stringify({ rules: [{ prefix: project, brain }] }));
    const env = {
      ...process.env,
      COMMONWEALTH_CONFIG: configPath,
      COMMONWEALTH_AUTHOR: "Alice Example",
      COMMONWEALTH_AUTHOR_EMAIL: "alice@example.com",
    };
    const candidate = JSON.stringify([
      { kind: "memory", title: "Attributed capture", body: "a durable hook-captured fact" },
    ]);

    execFileSync("node", [distEntry, "capture", "--dir", brain, "--cwd", project], {
      cwd: project,
      input: candidate,
      env,
      stdio: "pipe",
    });

    const people = await listNotes(brain, "person");
    const memories = await listNotes(brain, "memory");
    expect(people).toHaveLength(1);
    expect(people[0].frontmatter.name).toBe("Alice Example");
    expect(memories).toHaveLength(1);
    expect(memories[0].frontmatter.author).toBe("Alice Example");
    expect(memories[0].frontmatter.author_ref).toBe(people[0].frontmatter.id);
    expect(memories[0].frontmatter.relates).toContain(people[0].frontmatter.id);

    await fs.rm(root, { recursive: true, force: true });
  });

  it("creates and reuses a contributor person for explicit stage writes", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-curate-stage-attribution-")),
    );
    try {
      const brain = path.join(root, "brain");
      const env = {
        ...process.env,
        COMMONWEALTH_AUTHOR: "Stage Author",
        COMMONWEALTH_AUTHOR_EMAIL: "stage@example.com",
      };
      const stage = (title: string, body: string): void =>
        execFileSync(
          "node",
          [
            distEntry,
            "stage",
            "--dir",
            brain,
            "--kind",
            "memory",
            "--title",
            title,
            "--body",
            body,
          ],
          { cwd: root, env, stdio: "pipe" },
        );

      stage("First staged fact", "The first durable fact is held for manual review.");
      stage("Second staged fact", "The second durable fact is also held for manual review.");

      const people = await listNotes(brain, "person");
      const pending = await listPending(brain);
      expect(people).toHaveLength(1);
      expect(pending).toHaveLength(2);
      for (const note of pending) {
        expect(note.frontmatter.author).toBe("Stage Author");
        expect(note.frontmatter.author_ref).toBe(people[0].frontmatter.id);
        expect(note.frontmatter.relates).toContain(people[0].frontmatter.id);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("applies LLM curation verdicts end-to-end and emits the hook's summary line (ADR-0030)", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-curate-verdict-e2e-")),
    );
    try {
      const brain = path.join(root, "brain");
      await initBrain(brain, { name: "verdict-e2e" });
      // Seed a canon note the verdicts can target.
      await writeNote(brain, {
        id: "2026-07-01-jwt-a1",
        kind: "memory",
        title: "Auth uses JWT",
        body: "the service authenticates requests with fifteen-minute JWT access tokens",
      });
      const env = {
        ...process.env,
        COMMONWEALTH_AUTHOR: "Alice Example",
        COMMONWEALTH_AUTHOR_EMAIL: "alice@example.com",
      };
      const candidates = JSON.stringify([
        {
          kind: "memory",
          title: "Auth moved to opaque sessions",
          body: "we replaced the token scheme with opaque server-side session identifiers",
          verdict: { consolidation: "supersedes", targetId: "2026-07-01-jwt-a1" },
        },
        {
          kind: "memory",
          title: "Ran the test suite",
          body: "the whole suite went green on the first attempt today",
          verdict: { judge: "trivia" },
        },
        {
          kind: "memory",
          title: "Gateway now rejects JWT entirely",
          body: "the edge gateway refuses any JWT and only accepts opaque tokens now",
          verdict: { consolidation: "contradicts", targetId: "2026-07-01-jwt-a1" },
        },
      ]);

      const out = execFileSync("node", [distEntry, "capture", "--dir", brain, "--cwd", brain], {
        cwd: root,
        input: candidates,
        env,
        stdio: "pipe",
      }).toString();

      // The machine-readable summary line the plugin hook parses to build the receipt.
      const line = out.split("\n").find((l) => l.startsWith("##commonwealth:verdicts "));
      expect(line).toBeTruthy();
      const counts = JSON.parse(line!.slice("##commonwealth:verdicts ".length));
      expect(counts).toMatchObject({ superseded: 1, contradicted: 1, trivia: 1 });

      // The target canon note was superseded in place (supersede-not-delete).
      const target = await readNote(brain, "memory/2026-07-01-jwt-a1.md");
      expect(target.frontmatter.kind === "memory" && target.frontmatter.status).toBe("superseded");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
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

  it("project link/list/unlink round-trips and regenerates the router (ADR-0031)", async () => {
    const brain = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-curate-project-cli-"));
    await initBrain(brain, { name: "project-cli-brain" });
    await writeNote(brain, {
      kind: "work-state",
      title: "Storefront WIP",
      body: "building the storefront",
      source: "weareantenna/acme-website",
    });
    await writeNote(brain, {
      kind: "decision",
      title: "Kickoff scope",
      body: "agreed the engagement scope in the kickoff meeting",
      source: "Acme Website",
    });

    const run = (args: string[]) =>
      spawnSync("node", [distEntry, ...args, "--dir", brain], { cwd: repoRoot, encoding: "utf8" });

    // link → one project section in the regenerated router, both sources as provenance subheads.
    const linked = run([
      "project",
      "link",
      "acme-engagement",
      "weareantenna/acme-website",
      "Acme Website",
    ]);
    expect(linked.status).toBe(0);
    let md = await fs.readFile(path.join(brain, "COMMONWEALTH.md"), "utf8");
    expect(md.split("\n")).toContain("## acme-engagement");
    expect(md.split("\n")).toContain("### Acme Website");
    // Line-exact so a `##` heading isn't matched inside the `### Acme Website` subhead.
    expect(md.split("\n")).not.toContain("## Acme Website");

    // list → shows the project and its member sources.
    const listed = run(["project", "list"]);
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain("acme-engagement");
    expect(listed.stdout).toContain("weareantenna/acme-website");

    // unlink → derived router restored to two per-source sections (no note edits).
    const unlinked = run(["project", "unlink", "acme-engagement"]);
    expect(unlinked.status).toBe(0);
    md = await fs.readFile(path.join(brain, "COMMONWEALTH.md"), "utf8");
    expect(md).toContain("## Acme Website");
    expect(md).toContain("## weareantenna/acme-website");
    expect(md).not.toContain("## acme-engagement");

    await fs.rm(brain, { recursive: true, force: true });
  });

  it("project adopt stamps historical notes in one commit and retires the entry (#241)", async () => {
    const brain = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-curate-adopt-cli-"));
    await initBrain(brain, { name: "adopt-cli-brain" });
    await writeNote(brain, {
      kind: "work-state",
      title: "Storefront WIP",
      body: "building the storefront",
      source: "weareantenna/acme-website",
    });
    const commit = (msg: string): void => {
      execFileSync("git", ["-C", brain, "add", "-A"]);
      execFileSync("git", [
        "-C",
        brain,
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@example.com",
        "commit",
        "-q",
        "-m",
        msg,
      ]);
    };
    const run = (args: string[]) =>
      spawnSync("node", [distEntry, ...args, "--dir", brain], { cwd: repoRoot, encoding: "utf8" });

    run(["project", "link", "acme-engagement", "weareantenna/acme-website"]);
    commit("seed proven link"); // adopt refuses on a dirty worktree, so commit the setup first

    const dry = run(["project", "adopt", "acme-engagement", "--dry-run"]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("Dry run");
    // Dry-run wrote nothing: the note still has no project frontmatter.
    expect((await listNotes(brain, "work-state"))[0]!.frontmatter.project).toBeUndefined();

    const before = Number(
      execFileSync("git", ["-C", brain, "rev-list", "--count", "HEAD"], {
        encoding: "utf8",
      }).trim(),
    );
    const adopted = run(["project", "adopt", "acme-engagement"]);
    expect(adopted.status).toBe(0);
    expect(adopted.stdout).toContain("Adopted");
    // The note now carries the project; the alias entry is gone; exactly one new commit; clean tree.
    expect((await listNotes(brain, "work-state"))[0]!.frontmatter.project).toBe("acme-engagement");
    const after = Number(
      execFileSync("git", ["-C", brain, "rev-list", "--count", "HEAD"], {
        encoding: "utf8",
      }).trim(),
    );
    expect(after).toBe(before + 1);
    expect(
      execFileSync("git", ["-C", brain, "status", "--porcelain"], { encoding: "utf8" }).trim(),
    ).toBe("");
    const list = run(["project", "list"]);
    expect(list.stdout).not.toContain("acme-engagement");

    await fs.rm(brain, { recursive: true, force: true });
  });

  it("project link/adopt reject a pathological project id at the CLI (exit 2) (#241)", async () => {
    const brain = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-curate-idguard-"));
    await initBrain(brain, { name: "idguard-brain" });
    const run = (args: string[]) =>
      spawnSync("node", [distEntry, ...args, "--dir", brain], { cwd: repoRoot, encoding: "utf8" });

    const sep = run(["project", "link", "../evil", "some/source"]);
    expect(sep.status).toBe(2);
    expect(sep.stderr).toContain("path separator");

    const long = run(["project", "link", "x".repeat(300), "some/source"]);
    expect(long.status).toBe(2);
    expect(long.stderr).toContain("256-character limit");

    const adoptBad = run(["project", "adopt", "a/b"]);
    expect(adoptBad.status).toBe(2);
    expect(adoptBad.stderr).toContain("path separator");

    await fs.rm(brain, { recursive: true, force: true });
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
