import { describe, expect, it } from "vitest";
import type { Registry, Rule } from "@cmnwlth/core";
import { parseMatcher, parseRegistryArgs, type RegistryDeps, runRegistry } from "../src/index.js";

// `commonwealth registry` (ADR-0024): manage the unified brain-resolution ruleset.

/** Build fake {@link RegistryDeps} that record calls; override per test. */
function fakeDeps(overrides: Partial<RegistryDeps> = {}): {
  deps: RegistryDeps;
  calls: {
    added: Rule[];
    removed: Rule[];
    setDefault: Array<{ brain: string | null; remote?: string }>;
    sharedAdded: Array<{ brain: string; rule: Rule }>;
    sharedRemoved: Array<{ brain: string; matcher: Rule }>;
    importedBrains: string[];
    importedAll: number;
    logs: string[];
    out: string[];
  };
} {
  const calls = {
    added: [] as Rule[],
    removed: [] as Rule[],
    setDefault: [] as Array<{ brain: string | null; remote?: string }>,
    sharedAdded: [] as Array<{ brain: string; rule: Rule }>,
    sharedRemoved: [] as Array<{ brain: string; matcher: Rule }>,
    importedBrains: [] as string[],
    importedAll: 0,
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
    addSharedRule: async (brain, rule) => {
      calls.sharedAdded.push({ brain, rule });
      return { added: true, updated: false };
    },
    removeSharedRule: async (brain, matcher) => {
      calls.sharedRemoved.push({ brain, matcher });
      return { removed: 1 };
    },
    importBrain: async (brain) => {
      calls.importedBrains.push(brain);
      return { imported: 1, pruned: 0 };
    },
    importAll: async () => {
      calls.importedAll += 1;
      return { imported: 0, pruned: 1 };
    },
    wiredBrains: async () => ["/brains/a", "/brains/b"],
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

  it("parses --shared on route/deny/remove and the pull action (ADR-0024 §5)", () => {
    expect(parseRegistryArgs(["route", "org:o/*", "/b", "--shared"])).toEqual({
      action: "route",
      matcher: { org: "o/*" },
      brain: "/b",
      shared: true,
    });
    expect(parseRegistryArgs(["deny", "repo:o/s", "--shared"])).toEqual({
      action: "deny",
      matcher: { repo: "o/s" },
      shared: true,
    });
    expect(parseRegistryArgs(["remove", "path:~/x", "--shared"])).toEqual({
      action: "remove",
      matcher: { prefix: "~/x" },
      shared: true,
    });
    expect(parseRegistryArgs(["pull"])).toEqual({ action: "pull" });
  });

  it("rejects malformed invocations", () => {
    expect(parseRegistryArgs(["route", "repo:o/r"])).toBeNull(); // no brain
    expect(parseRegistryArgs(["allow", "nope"])).toBeNull(); // bad matcher
    expect(parseRegistryArgs(["allow", "org:x", "extra"])).toBeNull(); // extra positional
    expect(parseRegistryArgs(["bogus"])).toBeNull();
    expect(parseRegistryArgs(["allow", "org:x", "--shared"])).toBeNull(); // allow can't be shared
    expect(parseRegistryArgs(["default", "/b", "--shared"])).toBeNull(); // default is never shared
    expect(parseRegistryArgs(["pull", "extra"])).toBeNull();
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
    const { deps, calls } = fakeDeps({
      load: async () => ({ defaultBrain: { brain: "/d" } }) as Registry,
    });
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

  it("show prints the default brain and rules, tagging shared ones (ADR-0024 §5)", async () => {
    const registry: Registry = {
      defaultBrain: { brain: "/brains/antenna" },
      rules: [
        { org: "weareantenna/*", brain: "/brains/antenna", origin: "shared" },
        { repo: "weareantenna/secret", deny: true },
      ],
    };
    const { deps, calls } = fakeDeps({ load: async () => registry });
    const code = await runRegistry({ action: "show" }, deps);
    expect(code).toBe(0);
    const text = calls.out.join("\n");
    expect(text).toContain("default brain: /brains/antenna");
    expect(text).toContain("org:weareantenna/*");
    expect(text).toContain("[shared]");
    expect(text).toContain("DENY");
  });
});

describe("runRegistry — shared rules (ADR-0024 §5)", () => {
  it("route --shared writes to the target brain then materializes locally", async () => {
    const { deps, calls } = fakeDeps();
    const code = await runRegistry(
      { action: "route", matcher: { org: "weareantenna/*" }, brain: "/brains/team", shared: true },
      deps,
    );
    expect(code).toBe(0);
    expect(calls.sharedAdded).toEqual([{ brain: "/brains/team", rule: { org: "weareantenna/*" } }]);
    expect(calls.importedBrains).toEqual(["/brains/team"]);
    expect(calls.added).toEqual([]); // NOT written to the per-user config directly
  });

  it("deny --shared stores the team-wide deny in the default brain", async () => {
    const { deps, calls } = fakeDeps({
      load: async () => ({ defaultBrain: { brain: "/brains/team" } }) as Registry,
    });
    const code = await runRegistry(
      { action: "deny", matcher: { repo: "weareantenna/secret" }, shared: true },
      deps,
    );
    expect(code).toBe(0);
    expect(calls.sharedAdded).toEqual([
      { brain: "/brains/team", rule: { repo: "weareantenna/secret", deny: true } },
    ]);
    expect(calls.importedBrains).toEqual(["/brains/team"]);
  });

  it("deny --shared errors (exit 2) when there is no default brain to hold it", async () => {
    const { deps, calls } = fakeDeps({ load: async () => null });
    const code = await runRegistry(
      { action: "deny", matcher: { repo: "weareantenna/secret" }, shared: true },
      deps,
    );
    expect(code).toBe(2);
    expect(calls.sharedAdded).toEqual([]);
    expect(calls.logs.join("\n")).toContain("needs a default brain");
  });

  it("remove --shared sweeps every wired brain, then re-imports to prune", async () => {
    const { deps, calls } = fakeDeps();
    const code = await runRegistry(
      { action: "remove", matcher: { org: "weareantenna/*" }, shared: true },
      deps,
    );
    expect(code).toBe(0);
    expect(calls.sharedRemoved.map((s) => s.brain)).toEqual(["/brains/a", "/brains/b"]);
    expect(calls.importedAll).toBe(1);
  });

  it("pull materializes every wired brain's shared rules", async () => {
    const { deps, calls } = fakeDeps();
    const code = await runRegistry({ action: "pull" }, deps);
    expect(code).toBe(0);
    expect(calls.importedAll).toBe(1);
    expect(calls.logs.join("\n")).toContain("pulled shared rules");
  });
});
