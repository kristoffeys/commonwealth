import * as core from "@cmnwlth/core";

/**
 * `commonwealth registry` (ADR-0024) — manage the unified brain-resolution ruleset: match a
 * working directory by git identity (`repo`/`org`) or path (`prefix`), and route it to a brain,
 * deny it, or fall through to the default brain. Superseding the old `prefix → brain` mappings
 * (ADR-0011) and the separate scope allow/deny (ADR-0008), which are still read for back-compat.
 *
 *   commonwealth registry show
 *   commonwealth registry route <matcher> <brain> [--remote <url>]
 *   commonwealth registry allow <matcher>                 # → the default brain
 *   commonwealth registry deny  <matcher>
 *   commonwealth registry remove <matcher>
 *   commonwealth registry default <brain> [--remote <url>] | --clear
 *
 * A <matcher> is one of:
 *   repo:<owner/repo>   exact repo identity (git origin), e.g. repo:weareantenna/erp
 *   org:<owner>         all repos of an owner,           e.g. org:weareantenna  (or org:weareantenna/*)
 *   path:<dir>          a path prefix,                    e.g. path:~/work/acme
 *   *                   the catch-all (lowest precedence)
 */

/** Parsed `commonwealth registry` invocation. */
export interface RegistryOptions {
  action: "show" | "route" | "allow" | "deny" | "remove" | "default";
  /** Matcher-only rule (repo/org/prefix) for route/allow/deny/remove. */
  matcher?: core.Rule;
  /** Brain path for route / default. */
  brain?: string;
  /** Clone-on-demand remote for route / default. */
  remote?: string;
  /** `default --clear`: unset the default brain. */
  clear?: boolean;
}

/** Injected effects of {@link runRegistry}; wired for real in {@link defaultRegistryDeps}. */
export interface RegistryDeps {
  addRule(rule: core.Rule): Promise<{ added: boolean; updated: boolean }>;
  removeRule(matcher: core.Rule): Promise<{ removed: number }>;
  setDefaultBrain(brain: string | null, remote?: string): Promise<void>;
  load(): Promise<core.Registry | null>;
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
  if (kind === "path" || kind === "prefix") return { prefix: value };
  return null;
}

/** Parse `commonwealth registry` argv into {@link RegistryOptions}, or null on a usage error. */
export function parseRegistryArgs(rest: string[]): RegistryOptions | null {
  const action = rest[0];
  const positionals: string[] = [];
  let remote: string | undefined;
  let clear = false;
  for (let i = 1; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (arg === "--remote") {
      remote = rest[i + 1];
      if (remote === undefined || remote.length === 0) return null;
      i += 1;
    } else if (arg === "--clear") {
      clear = true;
    } else if (arg.startsWith("--")) {
      return null;
    } else {
      positionals.push(arg);
    }
  }

  if (action === "show" || action === undefined) return { action: "show" };

  if (action === "default") {
    if (clear) return { action: "default", clear: true };
    const brain = positionals[0];
    if (brain === undefined || positionals.length > 1) return null;
    return { action: "default", brain, ...(remote ? { remote } : {}) };
  }

  if (action === "route") {
    const matcher = parseMatcher(positionals[0]);
    const brain = positionals[1];
    if (!matcher || brain === undefined || positionals.length > 2) return null;
    return { action: "route", matcher, brain, ...(remote ? { remote } : {}) };
  }

  if (action === "allow" || action === "deny" || action === "remove") {
    const matcher = parseMatcher(positionals[0]);
    if (!matcher || positionals.length > 1) return null;
    return { action, matcher };
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
  return `  ${matcher.padEnd(32)} ${outcome}`;
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
        "       commonwealth registry route <matcher> <brain> [--remote <url>]\n" +
        "       commonwealth registry allow  <matcher>\n" +
        "       commonwealth registry deny   <matcher>\n" +
        "       commonwealth registry remove <matcher>\n" +
        "       commonwealth registry default <brain> [--remote <url>] | --clear\n" +
        "\n" +
        "  <matcher>: repo:<owner/repo> | org:<owner> | path:<dir> | *\n",
    );
    return 2;
  }
  return runRegistry(opts, defaultRegistryDeps());
}
