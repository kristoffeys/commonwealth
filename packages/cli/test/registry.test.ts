import { describe, expect, it } from "vitest";
import type { Registry, Rule } from "@cmnwlth/core";
import {
  parseMatcher,
  parseRegistryArgs,
  type RegistryDeps,
  runRegistry,
} from "../src/index.js";

// `commonwealth registry` (ADR-0024): manage the unified brain-resolution ruleset.

/** Build fake {@link RegistryDeps} that record calls; override per test. */
function fakeDeps(overrides: Partial<RegistryDeps> = {}): {
  deps: RegistryDeps;
  calls: {
    added: Rule[];
    removed: Rule[];
    setDefault: Array<{ brain: string | null; remote?: string }>;
    logs: string[];
    out: string[];
  };
} {
  const calls = {
    added: [] as Rule[],
    removed: [] as Rule[],
    setDefault: [] as Array<{ brain: string | null; remote?: string }>,
    logs: [] as string[],
    out: [] as string[],
  };
  const deps: RegistryDeps = {
    addRule: async (rule) => {
      calls.added.push(rule);
      return { added: true, updated: false };
    },
    removeRule: async (matcher) => {
      calls.removed.push(matcher);
      return { removed: 1 };
    },
    setDefaultBrain: async (brain, remote) => {
      calls.setDefault.push({ brain, ...(remote !== undefined ? { remote } : {}) });
    },
    load: async () => null,
    log: (m) => calls.logs.push(m),
    out: (m) => calls.out.push(m),
    ...overrides,
  };
  return { deps, calls };
}

describe("parseMatcher", () => {
  it("parses each matcher kind and the catch-all", () => {
    expect(parseMatcher("repo:weareantenna/erp")).toEqual({ repo: "weareantenna/erp" });
    expect(parseMatcher("org:weareantenna")).toEqual({ org: "weareantenna" });
    expect(parseMatcher("org:weareantenna/*")).toEqual({ org: "weareantenna/*" });
    expect(parseMatcher("path:~/work/acme")).toEqual({ prefix: "~/work/acme" });
    expect(parseMatcher("*")).toEqual({ prefix: "*" });
  });

  it("rejects unknown/empty/kindless tokens", () => {
    expect(parseMatcher(undefined)).toBeNull();
    expect(parseMatcher("weareantenna/erp")).toBeNull(); // no explicit kind
    expect(parseMatcher("repo:")).toBeNull();
    expect(parseMatcher("bogus:x")).toBeNull();
  });
});

describe("parseRegistryArgs", () => {
  it("parses route with a brain and --remote", () => {
    expect(parseRegistryArgs(["route", "repo:o/r", "/b", "--remote", "git@x:o.git"])).toEqual({
      action: "route",
      matcher: { repo: "o/r" },
      brain: "/b",
      remote: "git@x:o.git",
    });
  });

  it("parses allow / deny / remove with a matcher", () => {
    expect(parseRegistryArgs(["allow", "org:weareantenna/*"])).toEqual({
      action: "allow",
      matcher: { org: "weareantenna/*" },
    });
    expect(parseRegistryArgs(["deny", "repo:o/secret"])).toEqual({
      action: "deny",
      matcher: { repo: "o/secret" },
    });
    expect(parseRegistryArgs(["remove", "path:~/x"])).toEqual({
      action: "remove",
      matcher: { prefix: "~/x" },
    });
  });

  it("parses default set and --clear, and show / no-args", () => {
    expect(parseRegistryArgs(["default", "/b"])).toEqual({ action: "default", brain: "/b" });
    expect(parseRegistryArgs(["default", "--clear"])).toEqual({ action: "default", clear: true });
    expect(parseRegistryArgs(["show"])).toEqual({ action: "show" });
    expect(parseRegistryArgs([])).toEqual({ action: "show" });
  });

  it("rejects malformed invocations", () => {
    expect(parseRegistryArgs(["route", "repo:o/r"])).toBeNull(); // no brain
    expect(parseRegistryArgs(["allow", "nope"])).toBeNull(); // bad matcher
    expect(parseRegistryArgs(["allow", "org:x", "extra"])).toBeNull(); // extra positional
    expect(parseRegistryArgs(["bogus"])).toBeNull();
  });
});

describe("runRegistry", () => {
  it("route builds a routing rule with brain (+remote)", async () => {
    const { deps, calls } = fakeDeps();
    const code = await runRegistry(
      { action: "route", matcher: { repo: "o/r" }, brain: "/b", remote: "git@x:o.git" },
      deps,
    );
    expect(code).toBe(0);
    expect(calls.added).toEqual([{ repo: "o/r", brain: "/b", remote: "git@x:o.git" }]);
  });

  it("deny builds a deny rule; allow leaves a bare matcher", async () => {
    const { deps, calls } = fakeDeps({ load: async () => ({ mappings: [], defaultBrain: { brain: "/d" } }) as Registry });
    await runRegistry({ action: "deny", matcher: { repo: "o/s" } }, deps);
    await runRegistry({ action: "allow", matcher: { org: "o/*" } }, deps);
    expect(calls.added).toEqual([{ repo: "o/s", deny: true }, { org: "o/*" }]);
  });

  it("warns on a bare allow when no default brain is configured", async () => {
    const { deps, calls } = fakeDeps({ load: async () => null });
    await runRegistry({ action: "allow", matcher: { org: "o/*" } }, deps);
    expect(calls.logs.join("\n")).toContain("no default brain set");
  });

  it("default set and --clear call setDefaultBrain", async () => {
    const { deps, calls } = fakeDeps();
    await runRegistry({ action: "default", brain: "/b", remote: "git@x:o.git" }, deps);
    await runRegistry({ action: "default", clear: true }, deps);
    expect(calls.setDefault).toEqual([{ brain: "/b", remote: "git@x:o.git" }, { brain: null }]);
  });

  it("remove delegates to removeRule", async () => {
    const { deps, calls } = fakeDeps();
    await runRegistry({ action: "remove", matcher: { prefix: "/x" } }, deps);
    expect(calls.removed).toEqual([{ prefix: "/x" }]);
  });

  it("show prints default brain, rules, and legacy mappings", async () => {
    const registry: Registry = {
      defaultBrain: { brain: "/brains/antenna" },
      rules: [{ org: "weareantenna/*" }, { repo: "weareantenna/secret", deny: true }],
      mappings: [{ prefix: "/legacy", brain: "/brains/legacy" }],
    };
    const { deps, calls } = fakeDeps({ load: async () => registry });
    const code = await runRegistry({ action: "show" }, deps);
    expect(code).toBe(0);
    const text = calls.out.join("\n");
    expect(text).toContain("default brain: /brains/antenna");
    expect(text).toContain("org:weareantenna/*");
    expect(text).toContain("DENY");
    expect(text).toContain("legacy mappings");
  });
});
