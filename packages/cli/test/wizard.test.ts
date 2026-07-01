import { describe, expect, it } from "vitest";
import { runWizard, type WizardDefaults } from "../src/onboard.js";
import type { Prompter } from "../src/prompt.js";

const DEFAULTS: WizardDefaults = {
  brain: "/default/brain",
  scope: true,
  seed: true,
  mcp: true,
  daemon: true,
  autoAdr: false,
};

/**
 * A fake {@link Prompter} that returns scripted answers in order. `texts` feeds `text()` calls,
 * `confirms` feeds `confirm()` calls; each falls back to the prompt's own default if the script
 * runs dry, matching real Enter-accepts-default behaviour.
 */
function fakePrompter(script: { texts?: string[]; confirms?: boolean[] }): {
  prompter: Prompter;
  closed: () => boolean;
} {
  const texts = [...(script.texts ?? [])];
  const confirms = [...(script.confirms ?? [])];
  let wasClosed = false;
  const prompter: Prompter = {
    async text(_message, def) {
      return texts.length ? (texts.shift() as string) : def;
    },
    async confirm(_message, def) {
      return confirms.length ? (confirms.shift() as boolean) : def;
    },
    close() {
      wasClosed = true;
    },
  };
  return { prompter, closed: () => wasClosed };
}

describe("runWizard", () => {
  it("builds OnboardOptions from scripted answers (order: scope, seed, mcp, daemon, autoAdr, proceed)", async () => {
    const { prompter } = fakePrompter({
      texts: ["/my/brain", "git@github.com:me/brain.git"],
      // scope, seed, mcp, daemon, autoAdr, proceed
      confirms: [true, false, true, false, true, true],
    });

    const outcome = await runWizard(DEFAULTS, prompter);

    expect(outcome.proceed).toBe(true);
    expect(outcome.opts).toEqual({
      brain: "/my/brain",
      yes: true,
      seed: false,
      mcp: true,
      daemon: false,
      scope: true,
      autoAdr: true,
      remote: "git@github.com:me/brain.git",
    });
  });

  it("Enter-accepts-defaults: empty answers fall back to each prompt's default", async () => {
    // No scripted answers -> text() and confirm() return their defaults.
    const { prompter } = fakePrompter({});
    const outcome = await runWizard(DEFAULTS, prompter);

    expect(outcome.proceed).toBe(true);
    expect(outcome.opts).toEqual({
      brain: "/default/brain",
      yes: true,
      seed: true,
      mcp: true,
      daemon: true,
      scope: true,
      autoAdr: false,
      remote: undefined,
    });
  });

  it("blank remote (default) yields remote: undefined", async () => {
    const { prompter } = fakePrompter({
      texts: ["/b", ""],
      confirms: [true, true, true, true, true, true],
    });
    const outcome = await runWizard(DEFAULTS, prompter);
    expect(outcome.proceed).toBe(true);
    expect(outcome.opts?.remote).toBeUndefined();
  });

  it("carries yes:true so runOnboard does not double-prompt", async () => {
    const { prompter } = fakePrompter({});
    const outcome = await runWizard(DEFAULTS, prompter);
    expect(outcome.opts?.yes).toBe(true);
  });

  it("declined final Proceed? -> abort with no opts", async () => {
    const { prompter } = fakePrompter({
      texts: ["/b", ""],
      // scope, seed, mcp, daemon, autoAdr, proceed=false
      confirms: [true, true, true, true, false, false],
    });
    const outcome = await runWizard(DEFAULTS, prompter);

    expect(outcome.proceed).toBe(false);
    expect(outcome.opts).toBeNull();
  });
});
