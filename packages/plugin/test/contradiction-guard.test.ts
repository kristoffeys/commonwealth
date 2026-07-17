import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildContradictionOutput,
  contradictionGuard,
  DISABLE_HOOKS_ENV,
  summarizeToolInput,
} from "../hooks/lib.mjs";

/**
 * Action-time contradiction guard (#199, ADR-0033). The pure control flow is deps-injected exactly
 * like the other hooks, so these tests drive it with fake config + a fake embeddings check ("fake
 * embedder") and never touch a real brain or model. The posture under test is conservative: opt-in
 * (default off), non-blocking by default, decision-only, fail-open under a hard time budget, and
 * deduped once per decision per session.
 */

const MATCH = {
  id: "2026-07-01-use-postgres-a1b2",
  title: "Use PostgreSQL as the primary datastore",
  path: "decision/2026-07-01-use-postgres-a1b2.md",
  score: 0.9,
};

const WRITE_INPUT = {
  cwd: "/work/acme/app",
  session_id: "sess-1",
  tool_name: "Write",
  tool_input: { file_path: "db/config.ts", content: "migrate the datastore to MySQL for orders" },
};

/** Fresh spy-backed deps; overrides tune one seam per test. */
function makeDeps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    resolveBrain: vi.fn(async () => ({ kind: "brain", brain: "/brains/acme" })),
    loadGuardConfig: vi.fn(async () => ({
      enabled: true,
      mode: "warn",
      threshold: 0.82,
      hasProvider: true,
    })),
    findContradiction: vi.fn(async () => MATCH),
    wasWarned: vi.fn(async () => false),
    markWarned: vi.fn(async () => {}),
    ...overrides,
  };
}

afterEach(() => {
  delete process.env[DISABLE_HOOKS_ENV];
  vi.restoreAllMocks();
});

describe("summarizeToolInput", () => {
  it("summarizes a Bash command, a Write's content, and an Edit's new text", () => {
    expect(summarizeToolInput("Bash", { command: "dropdb orders && createdb orders" })).toContain(
      "dropdb orders",
    );
    expect(
      summarizeToolInput("Write", { file_path: "a.ts", content: "switch to MySQL now" }),
    ).toContain("switch to MySQL");
    expect(
      summarizeToolInput("Edit", {
        file_path: "a.ts",
        old_string: "pg",
        new_string: "the new mysql client wiring",
      }),
    ).toContain("the new mysql client wiring");
  });

  it("returns '' for an unknown tool or a trivially short payload (nothing to embed)", () => {
    expect(summarizeToolInput("Read", { file_path: "a.ts" })).toBe("");
    expect(summarizeToolInput("Bash", { command: "ls" })).toBe("");
  });
});

describe("buildContradictionOutput", () => {
  it("warn mode → non-blocking additionalContext naming the decision id + path", () => {
    const out = buildContradictionOutput(MATCH, "warn");
    expect(out?.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out?.hookSpecificOutput.additionalContext).toContain(`[[${MATCH.id}]]`);
    expect(out?.hookSpecificOutput.additionalContext).toContain(MATCH.path);
    // Non-blocking: NO permission decision, so the tool proceeds.
    expect(out?.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  it("ask mode → permissionDecision 'ask' with the same message as the reason", () => {
    const out = buildContradictionOutput(MATCH, "ask");
    expect(out?.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(out?.hookSpecificOutput.permissionDecisionReason).toContain(`[[${MATCH.id}]]`);
    expect(out?.hookSpecificOutput.additionalContext).toBeUndefined();
  });
});

describe("contradictionGuard", () => {
  it("is a complete no-op when the flag is off — zero embedding calls, tool proceeds", async () => {
    const deps = makeDeps({
      loadGuardConfig: vi.fn(async () => ({
        enabled: false,
        mode: "warn",
        threshold: 0.82,
        hasProvider: true,
      })),
    });
    const out = await contradictionGuard(WRITE_INPUT, deps);
    expect(out).toBeNull();
    expect(deps.findContradiction).not.toHaveBeenCalled();
  });

  it("no-ops for a brain with no embeddings provider (never embeds)", async () => {
    const deps = makeDeps({
      loadGuardConfig: vi.fn(async () => ({
        enabled: true,
        mode: "warn",
        threshold: 0.82,
        hasProvider: false,
      })),
    });
    const out = await contradictionGuard(WRITE_INPUT, deps);
    expect(out).toBeNull();
    expect(deps.findContradiction).not.toHaveBeenCalled();
  });

  it("warns (non-blocking) when a pending change contradicts a decision above threshold", async () => {
    const deps = makeDeps();
    const out = await contradictionGuard(WRITE_INPUT, deps);
    expect(out?.hookSpecificOutput.additionalContext).toContain(`[[${MATCH.id}]]`);
    expect(out?.hookSpecificOutput.additionalContext).toContain(MATCH.path);
    expect(out?.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(deps.findContradiction).toHaveBeenCalledTimes(1);
    expect(deps.markWarned).toHaveBeenCalledWith("sess-1", MATCH.id);
  });

  it("does not warn for an unrelated / below-threshold change", async () => {
    const deps = makeDeps({ findContradiction: vi.fn(async () => null) });
    const out = await contradictionGuard(WRITE_INPUT, deps);
    expect(out).toBeNull();
    expect(deps.markWarned).not.toHaveBeenCalled();
  });

  it("session-dedup: the same decision is not warned about twice in one session", async () => {
    const warned = new Set<string>();
    const deps = makeDeps({
      wasWarned: vi.fn(async (_key: string, id: string) => warned.has(id)),
      markWarned: vi.fn(async (_key: string, id: string) => {
        warned.add(id);
      }),
    });
    const first = await contradictionGuard(WRITE_INPUT, deps);
    const second = await contradictionGuard(WRITE_INPUT, deps);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("escalates to a permission 'ask' when the brain opts into ask mode", async () => {
    const deps = makeDeps({
      loadGuardConfig: vi.fn(async () => ({
        enabled: true,
        mode: "ask",
        threshold: 0.82,
        hasProvider: true,
      })),
    });
    const out = await contradictionGuard(WRITE_INPUT, deps);
    expect(out?.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(out?.hookSpecificOutput.permissionDecisionReason).toContain(`[[${MATCH.id}]]`);
  });

  it("fails open (allows) when the check throws — at most one breadcrumb, no re-warn", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = makeDeps({
      findContradiction: vi.fn(async () => {
        throw new Error("embedder exploded");
      }),
    });
    const out = await contradictionGuard(WRITE_INPUT, deps);
    expect(out).toBeNull();
    expect(deps.markWarned).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  it("fails open (allows) when the check hangs past the time budget", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = makeDeps({
      // Never resolves → the guard's hard timeout must win and allow the tool.
      findContradiction: vi.fn(() => new Promise(() => {})),
    });
    const out = await contradictionGuard(WRITE_INPUT, deps);
    expect(out).toBeNull();
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  it("no-ops when the recursion guard env is set (COMMONWEALTH_DISABLE_HOOKS)", async () => {
    process.env[DISABLE_HOOKS_ENV] = "1";
    const deps = makeDeps();
    const out = await contradictionGuard(WRITE_INPUT, deps);
    expect(out).toBeNull();
    expect(deps.resolveBrain).not.toHaveBeenCalled();
    expect(deps.findContradiction).not.toHaveBeenCalled();
  });

  it("ignores tools outside the guarded set and a missing cwd", async () => {
    const deps = makeDeps();
    expect(await contradictionGuard({ ...WRITE_INPUT, tool_name: "Read" }, deps)).toBeNull();
    expect(await contradictionGuard({ ...WRITE_INPUT, cwd: "" }, deps)).toBeNull();
    expect(deps.findContradiction).not.toHaveBeenCalled();
  });
});
