import { describe, expect, it } from "vitest";
import { runWizard, type WizardDefaults, type WizardDeps } from "../src/onboard.js";
import { parseSelection, type Prompter } from "../src/prompt.js";

const DEFAULTS: WizardDefaults = {
  brain: "/default/brain",
  repoRoot: "/home/me/projects/thisrepo",
  scope: true,
  seed: true,
  plugin: true,
  daemon: true,
  autoAdr: false,
};

/**
 * A fake {@link Prompter} that returns scripted answers in order. `texts` feeds `text()`,
 * `confirms` feeds `confirm()`, and `selects` feeds `select()` (each entry is the raw input a
 * user would type, resolved against the prompt's items via {@link parseSelection}). Each queue
 * falls back to the prompt's own default when it runs dry, matching Enter-accepts-default.
 */
function fakePrompter(script: { texts?: string[]; confirms?: boolean[]; selects?: string[] }): {
  prompter: Prompter;
  closed: () => boolean;
} {
  const texts = [...(script.texts ?? [])];
  const confirms = [...(script.confirms ?? [])];
  const selects = [...(script.selects ?? [])];
  let wasClosed = false;
  const prompter: Prompter = {
    async text(_message, def) {
      return texts.length ? (texts.shift() as string) : def;
    },
    async confirm(_message, def) {
      return confirms.length ? (confirms.shift() as boolean) : def;
    },
    async select(_message, items, defaultSelected) {
      const input = selects.length ? (selects.shift() as string) : "";
      return parseSelection(
        input,
        items.map((i) => i.value),
        defaultSelected,
      );
    },
    close() {
      wasClosed = true;
    },
  };
  return { prompter, closed: () => wasClosed };
}

/** A discovery stub returning a fixed repo list, recording the base dir it was asked to scan. */
function fakeScan(repos: string[]): { deps: WizardDeps; scannedFrom: () => string | null } {
  let scanned: string | null = null;
  const deps: WizardDeps = {
    async scan(baseDir) {
      scanned = baseDir;
      return repos;
    },
  };
  return { deps, scannedFrom: () => scanned };
}

describe("runWizard", () => {
  it("scans the parent of repoRoot by default", async () => {
    const { prompter } = fakePrompter({});
    const { deps, scannedFrom } = fakeScan([]);
    await runWizard(DEFAULTS, prompter, deps);
    expect(scannedFrom()).toBe("/home/me/projects");
  });

  it("multi-select drives syncFolders (all default) and seedRepos (subset)", async () => {
    const repos = ["/p/alpha", "/p/beta", "/p/gamma"];
    const { prompter } = fakePrompter({
      texts: ["/my/brain", "/p", ""], // brain, scanDir, remote
      selects: ["all", "1,3"], // sync=all, seed=alpha+gamma
      confirms: [true, true, false, true], // plugin, daemon, autoAdr, proceed
    });
    const { deps } = fakeScan(repos);

    const outcome = await runWizard(DEFAULTS, prompter, deps);

    expect(outcome.proceed).toBe(true);
    expect(outcome.opts?.syncFolders).toEqual(["/p/alpha", "/p/beta", "/p/gamma"]);
    expect(outcome.opts?.seedRepos).toEqual(["/p/alpha", "/p/gamma"]);
    expect(outcome.opts?.brain).toBe("/my/brain");
    expect(outcome.opts?.yes).toBe(true);
    expect(outcome.opts?.plugin).toBe(true);
    expect(outcome.opts?.daemon).toBe(true);
    expect(outcome.opts?.autoAdr).toBe(false);
    expect(outcome.opts?.seed).toBe(true);
  });

  it("empty select input keeps defaults: sync=all found, seed defaults to the sync set", async () => {
    const repos = ["/p/alpha", "/p/beta"];
    const { prompter } = fakePrompter({
      texts: ["/my/brain", "/p", ""],
      selects: [], // both selects fall back to their defaults
      confirms: [true, true, false, true],
    });
    const { deps } = fakeScan(repos);

    const outcome = await runWizard(DEFAULTS, prompter, deps);
    expect(outcome.opts?.syncFolders).toEqual(repos);
    expect(outcome.opts?.seedRepos).toEqual(repos);
  });

  it("seed 'none' yields empty seedRepos and seed:false", async () => {
    const repos = ["/p/alpha", "/p/beta"];
    const { prompter } = fakePrompter({
      texts: ["/my/brain", "/p", ""],
      selects: ["all", "none"],
      confirms: [true, true, false, true],
    });
    const { deps } = fakeScan(repos);

    const outcome = await runWizard(DEFAULTS, prompter, deps);
    expect(outcome.opts?.seedRepos).toEqual([]);
    expect(outcome.opts?.seed).toBe(false);
  });

  it("no repos found: falls back to [repoRoot] for both sync and seed", async () => {
    const { prompter } = fakePrompter({
      texts: ["/my/brain", "/p", ""],
      confirms: [true, true, false, true],
    });
    const { deps } = fakeScan([]);

    const outcome = await runWizard(DEFAULTS, prompter, deps);
    expect(outcome.opts?.syncFolders).toEqual([DEFAULTS.repoRoot]);
    expect(outcome.opts?.seedRepos).toEqual([DEFAULTS.repoRoot]);
  });

  it("carries yes:true so runOnboard does not double-prompt", async () => {
    const { prompter } = fakePrompter({});
    const { deps } = fakeScan([]);
    const outcome = await runWizard(DEFAULTS, prompter, deps);
    expect(outcome.opts?.yes).toBe(true);
  });

  it("blank remote (default) yields remote: undefined", async () => {
    const { prompter } = fakePrompter({ texts: ["/b", "/p", ""] });
    const { deps } = fakeScan([]);
    const outcome = await runWizard(DEFAULTS, prompter, deps);
    expect(outcome.opts?.remote).toBeUndefined();
  });

  it("declined final Proceed? -> abort with no opts", async () => {
    const { prompter } = fakePrompter({
      texts: ["/b", "/p", ""],
      confirms: [true, true, false, false], // plugin, daemon, autoAdr, proceed=false
    });
    const { deps } = fakeScan([]);
    const outcome = await runWizard(DEFAULTS, prompter, deps);

    expect(outcome.proceed).toBe(false);
    expect(outcome.opts).toBeNull();
  });
});
