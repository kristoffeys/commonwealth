import * as core from "@cmnwlth/core";

/**
 * `commonwealth registry` (ADR-0024) — manage the unified brain-resolution ruleset: match a
 * working directory by git identity (`repo`/`org`) or path (`prefix`), and route it to a brain,
 * deny it, or fall through to the default brain. Lives alongside the scope allow/deny (ADR-0008)
 * in the same per-user `config.json`.
 *
 *   commonwealth registry show
 *   commonwealth registry route <matcher> <brain> [--remote <url>] [--shared]
 *   commonwealth registry allow <matcher>                 # → the default brain
 *   commonwealth registry deny  <matcher> [--shared]
 *   commonwealth registry remove <matcher> [--shared]
 *   commonwealth registry default <brain> [--remote <url>] | --clear
 *   commonwealth registry pull                            # materialize teams' shared rules
 *
 * `--shared` (ADR-0024 §5) stores the rule in the target brain's committed `sharedRules` (route →
 * the named brain; deny → the default brain) so it syncs to the whole team; local rules override
 * shared. `pull` re-materializes every wired brain's shared rules into the per-user config.
 *
 * A <matcher> is one of:
 *   repo:<owner/repo>   exact repo identity (git origin), e.g. repo:weareantenna/erp
 *   org:<owner>         all repos of an owner,           e.g. org:weareantenna  (or org:weareantenna/*)
 *   path:<dir>          a path prefix,                    e.g. path:~/work/acme
 *   *                   the catch-all (lowest precedence)
 */

/** Parsed `commonwealth registry` invocation. */
export interface RegistryOptions {
  action: "show" | "route" | "allow" | "deny" | "remove" | "default" | "pull";
  /** Matcher-only rule (repo/org/prefix) for route/allow/deny/remove. */
  matcher?: core.Rule;
  /** Brain path for route / default. */
  brain?: string;
  /** Clone-on-demand remote for route / default. */
  remote?: string;
  /** `default --clear`: unset the default brain. */
  clear?: boolean;
  /**
   * `--shared` (ADR-0024 §5): write this route/deny/remove to the target brain's committed,
   * team-synced `sharedRules` instead of the local per-user config, and materialize it locally.
   */
  shared?: boolean;
}

/** Injected effects of {@link runRegistry}; wired for real in {@link defaultRegistryDeps}. */
export interface RegistryDeps {
  addRule(rule: core.Rule): Promise<{ added: boolean; updated: boolean }>;
  removeRule(matcher: core.Rule): Promise<{ removed: number }>;
  setDefaultBrain(brain: string | null, remote?: string): Promise<void>;
  load(): Promise<core.Registry | null>;
  /** Write a SHARED rule into `brainDir`'s committed config (ADR-0024 §5). */
  addSharedRule(brainDir: string, rule: core.Rule): Promise<{ added: boolean; updated: boolean }>;
  /** Remove a SHARED rule from `brainDir`'s committed config. */
  removeSharedRule(brainDir: string, matcher: core.Rule): Promise<{ removed: number }>;
  /** Materialize one brain's shared rules into the per-user config. */
  importBrain(brainDir: string): Promise<{ imported: number; pruned: number }>;
  /** Materialize every wired brain's shared rules into the per-user config. */
  importAll(): Promise<{ imported: number; pruned: number }>;
  /** Every wired brain directory (for a shared `remove` that sweeps all brains). */
  wiredBrains(): Promise<string[]>;
  /** Diagnostic sink (stderr in production). */
  log(m: string): void;
  /** Result sink (stdout in production). */
  out(m: string): void;
}

/**
 * Parse a `<matcher>` token into a matcher-only {@link core.Rule}, or null on a malformed token.
 * Kinds must be explicit (`repo:` / `org:` / `path:`) to avoid ambiguity; bare `*` is the catch-all.
 */
export function parseMatcher(token: string | undefined): core.Rule | null {
  if (!token) return null;
  if (token === "*") return { prefix: "*" };
  const sep = token.indexOf(":");
  if (sep <= 0) return null;
  const kind = token.slice(0, sep);
  const value = token.slice(sep + 1);
  if (value.length === 0) return null;
  if (kind === "repo") return { repo: value };
  if (kind === "org") return { org: value };
  if (kind === "path") return { prefix: value };
  return null;
}

/** Parse `commonwealth registry` argv into {@link RegistryOptions}, or null on a usage error. */
export function parseRegistryArgs(rest: string[]): RegistryOptions | null {
  const action = rest[0];
  const positionals: string[] = [];
  let remote: string | undefined;
  let clear = false;
  let shared = false;
  for (let i = 1; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (arg === "--remote") {
      remote = rest[i + 1];
      if (remote === undefined || remote.length === 0) return null;
      i += 1;
    } else if (arg === "--clear") {
      clear = true;
    } else if (arg === "--shared") {
      shared = true;
    } else if (arg.startsWith("--")) {
      return null;
    } else {
      positionals.push(arg);
    }
  }

  if (action === "show" || action === undefined) return { action: "show" };
  if (action === "pull") {
    if (positionals.length > 0) return null;
    return { action: "pull" };
  }

  if (action === "default") {
    if (shared) return null; // the default brain is a per-user pointer, never shared
    if (clear) return { action: "default", clear: true };
    const brain = positionals[0];
    if (brain === undefined || positionals.length > 1) return null;
    return { action: "default", brain, ...(remote ? { remote } : {}) };
  }

  if (action === "route") {
    const matcher = parseMatcher(positionals[0]);
    const brain = positionals[1];
    if (!matcher || brain === undefined || positionals.length > 2) return null;
    return {
      action: "route",
      matcher,
      brain,
      ...(remote ? { remote } : {}),
      ...(shared ? { shared: true } : {}),
    };
  }

  if (action === "allow") {
    if (shared) return null; // use `route <matcher> <brain> --shared` for a shared route
    const matcher = parseMatcher(positionals[0]);
    if (!matcher || positionals.length > 1) return null;
    return { action: "allow", matcher };
  }

  if (action === "deny" || action === "remove") {
    const matcher = parseMatcher(positionals[0]);
    if (!matcher || positionals.length > 1) return null;
    return { action, matcher, ...(shared ? { shared: true } : {}) };
  }

  return null;
}

/** Human-readable one-line form of a rule for `show`. */
function formatRule(rule: core.Rule): string {
  const matcher = rule.repo
    ? `repo:${rule.repo}`
    : rule.org
      ? `org:${rule.org}`
      : rule.prefix === "*"
        ? "*"
        : `path:${rule.prefix}`;
  const outcome = rule.deny
    ? "DENY"
    : rule.brain
      ? `→ ${rule.brain}${rule.remote ? ` (remote ${rule.remote})` : ""}`
      : "→ (default brain)";
  // Shared rules (ADR-0024 §5) are synced from a brain; tag them so `show` distinguishes them from
  // the machine-local rules a `local` override would win against.
  const origin = rule.origin === "shared" ? " [shared]" : "";
  return `  ${matcher.padEnd(32)} ${outcome}${origin}`;
}

/**
 * Handle a `--shared` route/deny/remove (ADR-0024 §5): write the rule into a brain's committed
 * `sharedRules` (so it syncs to the team), then materialize the change into the per-user config.
 *   - route → the explicit target brain holds the shared route;
 *   - deny  → the **default brain** holds the team-wide shared deny (errors if none is set);
 *   - remove → sweep the matcher out of EVERY wired brain, then re-import to prune.
 * @returns Exit code: 0 success, 1 write failure, 2 usage/validation error.
 */
async function runSharedWrite(opts: RegistryOptions, deps: RegistryDeps): Promise<number> {
  const matcher = opts.matcher as core.Rule;
  try {
    if (opts.action === "route") {
      const brain = opts.brain as string;
      const { added, updated } = await deps.addSharedRule(brain, matcher);
      const { imported } = await deps.importBrain(brain);
      deps.log(
        `registry: ${added ? "added" : updated ? "updated" : "unchanged"} shared rule ` +
          `${formatRule({ ...matcher, brain, origin: "shared" }).trim()} in ${brain} ` +
          `(${imported} materialized locally)`,
      );
      return 0;
    }
    if (opts.action === "deny") {
      const reg = await deps.load();
      const target = reg?.defaultBrain?.brain;
      if (!target) {
        deps.log(
          "registry: a shared deny needs a default brain to live in — set one with " +
            "`commonwealth registry default <brain>`, then retry.",
        );
        return 2;
      }
      const { added, updated } = await deps.addSharedRule(target, { ...matcher, deny: true });
      await deps.importBrain(target);
      deps.log(
        `registry: ${added ? "added" : updated ? "updated" : "unchanged"} shared deny ` +
          `${formatRule({ ...matcher, deny: true, origin: "shared" }).trim()} in ${target}`,
      );
      return 0;
    }
    // remove: sweep every wired brain, then re-import to prune the local materialization.
    const brains = await deps.wiredBrains();
    let removed = 0;
    for (const brain of brains) removed += (await deps.removeSharedRule(brain, matcher)).removed;
    const { pruned } = await deps.importAll();
    deps.log(
      removed > 0
        ? `registry: removed ${removed} shared rule(s) across ${brains.length} brain(s) (${pruned} pruned locally)`
        : "registry: no matching shared rule in any wired brain",
    );
    return 0;
  } catch (err) {
    deps.log(`registry: FAILED to write shared rule: ${(err as Error).message}`);
    return 1;
  }
}

/**
 * Run a `commonwealth registry` action. Pure orchestration over {@link RegistryDeps}.
 * @returns Exit code: 0 success, 1 write failure, 2 usage/validation error.
 */
export async function runRegistry(opts: RegistryOptions, deps: RegistryDeps): Promise<number> {
  if (opts.action === "show") {
    const reg = await deps.load();
    if (!reg) {
      deps.out("registry: empty (no rules configured)");
      return 0;
    }
    deps.out(
      `default brain: ${reg.defaultBrain ? reg.defaultBrain.brain : "(none — bare allows resolve to nothing)"}`,
    );
    const rules = reg.rules ?? [];
    deps.out(rules.length ? `rules (${rules.length}):` : "rules: none");
    for (const r of rules) deps.out(formatRule(r));
    return 0;
  }

  if (opts.action === "pull") {
    try {
      const { imported, pruned } = await deps.importAll();
      deps.log(`registry: pulled shared rules (${imported} imported, ${pruned} pruned)`);
    } catch (err) {
      deps.log(`registry: FAILED to pull shared rules: ${(err as Error).message}`);
      return 1;
    }
    return 0;
  }

  // Shared writes (ADR-0024 §5) target a brain's committed `sharedRules`, then materialize locally.
  if (
    opts.shared &&
    (opts.action === "route" || opts.action === "deny" || opts.action === "remove")
  ) {
    return runSharedWrite(opts, deps);
  }

  if (opts.action === "default") {
    try {
      if (opts.clear) {
        await deps.setDefaultBrain(null);
        deps.log("registry: cleared the default brain");
      } else {
        await deps.setDefaultBrain(opts.brain as string, opts.remote);
        deps.log(
          `registry: default brain = ${opts.brain}${opts.remote ? ` (remote ${opts.remote})` : ""}`,
        );
      }
    } catch (err) {
      deps.log(`registry: FAILED to set default brain: ${(err as Error).message}`);
      return 1;
    }
    return 0;
  }

  if (opts.action === "remove") {
    try {
      const { removed } = await deps.removeRule(opts.matcher as core.Rule);
      deps.log(removed ? `registry: removed ${removed} rule(s)` : "registry: no matching rule");
    } catch (err) {
      deps.log(`registry: FAILED to remove rule: ${(err as Error).message}`);
      return 1;
    }
    return 0;
  }

  // route / allow / deny → build the rule and add it.
  const rule: core.Rule = { ...(opts.matcher as core.Rule) };
  if (opts.action === "route") {
    rule.brain = opts.brain;
    if (opts.remote) rule.remote = opts.remote;
  } else if (opts.action === "deny") {
    rule.deny = true;
  }
  // `allow` leaves the rule as a bare matcher → routes to the default brain.

  // A bare allow is useless with no default brain configured — warn (but still record it, so a
  // later `registry default` completes the wiring).
  if (opts.action === "allow") {
    const reg = await deps.load();
    if (!reg?.defaultBrain) {
      deps.log(
        "registry: warning — no default brain set, so this allow resolves to nothing yet. " +
          "Set one with `commonwealth registry default <brain>`.",
      );
    }
  }

  try {
    const { added, updated } = await deps.addRule(rule);
    deps.log(
      `registry: ${added ? "added" : updated ? "updated" : "unchanged"} rule ${formatRule(rule).trim()}`,
    );
  } catch (err) {
    deps.log(`registry: FAILED to add rule: ${(err as Error).message}`);
    return 1;
  }
  return 0;
}

/** The real {@link RegistryDeps}: core registry IO, stderr diagnostics, stdout results. */
export function defaultRegistryDeps(): RegistryDeps {
  return {
    addRule: (rule) => core.addRule(rule),
    removeRule: (matcher) => core.removeRule(matcher),
    setDefaultBrain: (brain, remote) => core.setDefaultBrain(brain, remote ? { remote } : {}),
    load: () => core.loadRegistryFile(),
    addSharedRule: (brainDir, rule) => core.addSharedRule(brainDir, rule),
    removeSharedRule: (brainDir, matcher) => core.removeSharedRule(brainDir, matcher),
    importBrain: (brainDir) => core.importSharedRules(brainDir),
    importAll: () => core.importAllSharedRules(),
    wiredBrains: () => core.listWiredBrainDirs(),
    log: (m) => {
      process.stderr.write(`${m}\n`);
    },
    out: (m) => {
      process.stdout.write(`${m}\n`);
    },
  };
}

/** Entry point wired into the CLI dispatch: parse argv, then run. */
export async function cmdRegistry(rest: string[]): Promise<number> {
  const opts = parseRegistryArgs(rest);
  if (opts === null) {
    process.stderr.write(
      "usage: commonwealth registry show\n" +
        "       commonwealth registry route <matcher> <brain> [--remote <url>] [--shared]\n" +
        "       commonwealth registry allow  <matcher>\n" +
        "       commonwealth registry deny   <matcher> [--shared]\n" +
        "       commonwealth registry remove <matcher> [--shared]\n" +
        "       commonwealth registry default <brain> [--remote <url>] | --clear\n" +
        "       commonwealth registry pull\n" +
        "\n" +
        "  <matcher>: repo:<owner/repo> | org:<owner> | path:<dir> | *\n" +
        "  --shared:  store the rule in the brain's committed config so it syncs to the team\n" +
        "             (ADR-0024 §5); local rules override shared. `pull` re-materializes them.\n",
    );
    return 2;
  }
  return runRegistry(opts, defaultRegistryDeps());
}
