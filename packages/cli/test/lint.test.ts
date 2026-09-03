import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initBrain,
  lintBrain,
  regenerateDerived,
  writeNote,
  type HygieneReport,
} from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatLint, runLint, type LintEnv } from "../src/lint.js";

/**
 * `commonwealth lint` orchestration (#258). The `lint`/`rebuildDerived` surfaces are injected so
 * tests run against a fixture brain with no real registry lookup, matching `verify.test.ts`'s style.
 */
describe("runLint", () => {
  let tmp: string;
  let brain: string;
  let cwd: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cw-lint-cli-"));
    brain = path.join(tmp, "brain");
    cwd = path.join(tmp, "project");
    await fs.mkdir(cwd, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const cleanReport: HygieneReport = {
    dir: brain,
    fileCount: 0,
    noteCount: 0,
    findings: [],
    staleDerived: [],
    orphanCount: 0,
    counts: { error: 0, warn: 0, info: 0 },
    ok: true,
  };

  function env(overrides: Partial<LintEnv> = {}): LintEnv {
    return {
      cwd,
      resolveBrain: () => Promise.resolve(brain),
      lint: () => Promise.resolve(cleanReport),
      rebuildDerived: () => Promise.resolve(),
      ...overrides,
    };
  }

  it("throws a helpful error naming `commonwealth add` when no brain resolves", async () => {
    await expect(runLint({}, env({ resolveBrain: () => Promise.resolve(null) }))).rejects.toThrow(
      /commonwealth add/,
    );
  });

  it("reports ok and no rebuild for a clean brain; formatLint shows the check mark", async () => {
    const run = await runLint({}, env());
    expect(run.ok).toBe(true);
    expect(run.rebuilt).toEqual([]);
    expect(formatLint(run)).toContain("✓");
  });

  it("reports not-ok for error findings; formatLint groups them by file and names the rule", async () => {
    const report: HygieneReport = {
      ...cleanReport,
      noteCount: 1,
      findings: [
        {
          rule: "dead-supersede",
          severity: "error",
          where: "memory/a.md",
          message: "superseded_by: `ghost` — no note with that id",
        },
      ],
      counts: { error: 1, warn: 0, info: 0 },
      ok: false,
    };
    const run = await runLint({}, env({ lint: () => Promise.resolve(report) }));
    expect(run.ok).toBe(false);
    const text = formatLint(run);
    expect(text).toContain("memory/a.md");
    expect(text).toContain("dead-supersede");
  });

  it("--fix rebuilds stale derived views once and returns the re-lint (staleDerived cleared)", async () => {
    const stale: HygieneReport = {
      ...cleanReport,
      staleDerived: ["COMMONWEALTH.md"],
      findings: [
        {
          rule: "stale-derived",
          severity: "warn",
          where: "COMMONWEALTH.md",
          message: "drifted from the notes it derives from",
        },
      ],
      counts: { error: 0, warn: 1, info: 0 },
    };

    let calls = 0;
    let rebuildCalls = 0;
    const run = await runLint(
      { fix: true },
      env({
        lint: () => {
          calls += 1;
          return Promise.resolve(calls === 1 ? stale : cleanReport);
        },
        rebuildDerived: () => {
          rebuildCalls += 1;
          return Promise.resolve();
        },
      }),
    );

    expect(rebuildCalls).toBe(1);
    expect(run.rebuilt).toEqual(["COMMONWEALTH.md"]);
    expect(run.report.staleDerived).toEqual([]);
    expect(run.ok).toBe(true);
  });

  it("--fix does not call rebuildDerived when nothing is stale", async () => {
    let rebuildCalls = 0;
    const run = await runLint(
      { fix: true },
      env({ rebuildDerived: () => Promise.resolve((rebuildCalls += 1) && undefined) }),
    );
    expect(rebuildCalls).toBe(0);
    expect(run.rebuilt).toEqual([]);
  });

  it("--orphans passes reportOrphans: true through to the lint", async () => {
    let seenOpts: { reportOrphans: boolean } | null = null;
    await runLint(
      { orphans: true },
      env({
        lint: (_brainDir, opts) => {
          seenOpts = opts;
          return Promise.resolve(cleanReport);
        },
      }),
    );
    expect(seenOpts).toEqual({ reportOrphans: true });
  });
});

/** Real `lintBrain` + `regenerateDerived` against a fixture brain, proving the `--fix` re-lint end to end. */
describe("runLint against a real brain", () => {
  let tmp: string;
  let brain: string;
  let cwd: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cw-lint-real-"));
    brain = path.join(tmp, "brain");
    cwd = path.join(tmp, "project");
    await fs.mkdir(cwd, { recursive: true });
    await initBrain(brain, { name: "test-brain" });
    await writeNote(brain, { kind: "memory", title: "Alpha", body: "the alpha fact" });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  function env(overrides: Partial<LintEnv> = {}): LintEnv {
    return {
      cwd,
      resolveBrain: () => Promise.resolve(brain),
      lint: (brainDir, opts) => lintBrain(brainDir, { reportOrphans: opts.reportOrphans }),
      // `{ prune: false }` mirrors the real `defaultLintEnv` wiring — the `--fix` repair regenerates
      // the planned derived set but never sweeps unrecognized markdown (a hand-written PLAYBOOK.md,
      // a project-root NOTES.md) that `isDerivedMarkdownFile` would otherwise misclassify as derived.
      rebuildDerived: (brainDir) => regenerateDerived(brainDir, { prune: false }),
      ...overrides,
    };
  }

  it("regenerates the stale derived view and reports clean afterwards", async () => {
    const run = await runLint({ fix: true }, env());
    expect(run.rebuilt).toContain("COMMONWEALTH.md");
    expect(run.report.staleDerived).toEqual([]);
    expect(run.ok).toBe(true);
  });

  it("--fix never deletes a hand-written markdown file at a brain or project root", async () => {
    // The guarantee `--fix` advertises, and the one it previously broke. `isDerivedMarkdownFile`
    // classifies ANY non-`README` markdown at a brain/project-folder root as derived, so the
    // regenerate prune sweep used to delete a teammate's hand-written file as collateral. The
    // self-heal now runs with `prune: false`: it writes the drifted views and removes nothing.
    await writeNote(brain, { kind: "memory", title: "Sourced", body: "x", source: "acme/app" });
    const playbook = path.join(brain, "PLAYBOOK.md");
    const projectNotes = path.join(brain, "acme-app", "NOTES.md");
    await fs.mkdir(path.join(brain, "acme-app"), { recursive: true });
    await fs.writeFile(playbook, "Hand-written team playbook.\n");
    await fs.writeFile(projectNotes, "Hand-written project notes.\n");
    // Drift the hub so `--fix` actually has something to repair.
    await fs.appendFile(path.join(brain, "COMMONWEALTH.md"), "drift\n");

    const run = await runLint({ fix: true }, env());

    expect(run.rebuilt).toContain("COMMONWEALTH.md");
    expect(run.report.staleDerived).toEqual([]);
    expect(await fs.readFile(playbook, "utf8")).toBe("Hand-written team playbook.\n");
    expect(await fs.readFile(projectNotes, "utf8")).toBe("Hand-written project notes.\n");
  });

  it("propagates lintBrain's throw when the resolved brain directory does not exist", async () => {
    const missing = path.join(tmp, "does-not-exist");
    await expect(
      runLint({}, env({ resolveBrain: () => Promise.resolve(missing) })),
    ).rejects.toThrow(/Not a brain directory/);
  });
});
