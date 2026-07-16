import path from "node:path";
import { promises as fs } from "node:fs";
import { parseArgs } from "node:util";
import {
  attributeNoteInputs,
  brainHealth,
  brainMap,
  computeBrainHealth,
  computeHealthByProject,
  ensureContributorPerson,
  FEATURE_FLAGS,
  linkSources,
  listNotes,
  loadBrainConfig,
  loadProjectAliasMap,
  manifestStamp,
  type NewNoteInput,
  NOTE_KINDS,
  type NoteKind,
  persistProjectAliasMap,
  projectIdError,
  refreshBrainStatus,
  regenerateDerived,
  resolveBrain,
  resolveBrainDir,
  resolveContributorIdentity,
  resolveProjectManifest,
  resolveProjectSource,
  setFeature,
  unlinkSources,
  buildIndex,
} from "@cmnwlth/core";
import { adoptProject, type AdoptResult } from "./adopt.js";
import { captureCandidates } from "./capture.js";
import { consolidateCanon } from "./consolidate.js";
import { graduateToOrgBrain } from "./graduate.js";
import { formatContext } from "./context.js";
import { curate } from "./curate.js";
import { computeNeighbors } from "./neighbors.js";
import { reassignStagedContributor } from "./staging.js";
import { selectRelevant } from "./relevance.js";
import { approve, approveAll, listPending, reject } from "./review.js";
import { addAllow, addDeny, loadUserConfig } from "./scope.js";
import type { AnnotatedCandidate } from "./verdict.js";
import packageJson from "../package.json";

/**
 * Sentinel line the `capture` command appends to stdout to carry the LLM curation verdict summary
 * (ADR-0030) back to the plugin hook, which uses it to render the capture receipt. It has NO
 * `[kind]` bracket, so the hook's note-line parser skips it; the hook parses this line separately.
 * Keep in sync with `parseVerdictSummary` in packages/plugin/hooks/lib.mjs.
 */
const VERDICT_SUMMARY_PREFIX = "##commonwealth:verdicts ";

/**
 * Resolve the brain directory for a `cwd`, or `null` when none is configured (#69). Order:
 * an explicit `--dir` → `$COMMONWEALTH_BRAIN_DIR` → `@cmnwlth/core`'s registry resolver
 * against `cwd` (marker → ancestor-brain → user registry). Unlike the old resolver this
 * consults the registry, so the CLI hits the SAME brain the MCP server and hooks do rather
 * than silently operating on the current directory.
 */
async function resolveDir(
  explicit: string | undefined,
  cwd = process.cwd(),
): Promise<string | null> {
  if (explicit && explicit.length > 0) return path.resolve(explicit);
  const env = process.env.COMMONWEALTH_BRAIN_DIR;
  if (env && env.length > 0) return path.resolve(env);
  return resolveBrainDir(cwd);
}

/** An explicit destination brain (`--dir` → `$COMMONWEALTH_BRAIN_DIR`), or null when neither is set. */
function explicitBrain(explicit: string | undefined): string | null {
  if (explicit && explicit.length > 0) return path.resolve(explicit);
  const env = process.env.COMMONWEALTH_BRAIN_DIR;
  return env && env.length > 0 ? path.resolve(env) : null;
}

/**
 * Resolve the brain for a *session* `cwd`, applying the ADR-0024 scope gate in a single pass — the
 * unification that retires `isInScope`. `resolveBrain` folds the scope `allow`/`deny` into its
 * ruleset and answers three ways, and that answer IS the scope gate: `denied` (an explicit deny —
 * out of scope), `none` (nothing configured here — out of scope), or `brain` (in scope, routed).
 * Only an **in-scope** cwd captures; an explicit `--dir`/`$COMMONWEALTH_BRAIN_DIR` then overrides
 * the *destination* (as it always did — env even reinstates scope via `resolveBrain`'s own env
 * fallback, which is how the hooks pass the already-resolved brain through). `force` is the
 * deliberate-import escape hatch: it bypasses the gate entirely but still needs a destination.
 * Returns the brain to use, or a skip + reason that maps onto the hooks' "out-of-scope"/"no-brain".
 */
async function resolveScopedBrain(
  explicit: string | undefined,
  cwd: string,
  opts: { force?: boolean } = {},
): Promise<{ brain: string } | { skip: "out-of-scope" | "no-brain" }> {
  const resolution = await resolveBrain(cwd);
  if (opts.force) {
    // Deliberate import: skip the gate, but a destination is still required.
    const dest = explicitBrain(explicit) ?? (resolution.kind === "brain" ? resolution.brain : null);
    return dest ? { brain: dest } : { skip: "no-brain" };
  }
  // The resolution is the gate. An explicit brain only redirects an already-in-scope capture.
  if (resolution.kind === "denied") return { skip: "out-of-scope" };
  if (resolution.kind === "none") return { skip: "no-brain" };
  if (resolution.kind === "corrupt-config") {
    // The per-user config file is unparseable (#210). `resolveBrain` already honors an explicit
    // env/`--dir` brain OVER a corrupt config, so reaching here means none was pinned: skip like
    // no-brain (the hook layer surfaces the loud "fix your config" receipt), unless an explicit
    // brain redirects us anyway.
    const dest = explicitBrain(explicit);
    return dest ? { brain: dest } : { skip: "no-brain" };
  }
  return { brain: explicitBrain(explicit) ?? resolution.brain };
}

/** Message + exit when a brain-requiring command finds no brain for `cwd` (#69). */
function noBrain(cwd: string): never {
  console.error(
    `[commonwealth-curate] no Commonwealth brain configured for ${cwd} — run \`commonwealth init\` ` +
      `here, add a prefix → brain mapping to ~/.commonwealth/registry.json, or pass --dir <brain>.`,
  );
  process.exit(1);
}

/** Print usage to stderr. */
function usage(): void {
  console.error(
    [
      "commonwealth-curate — curation + in-repo review queue",
      "",
      "Usage:",
      "  commonwealth-curate list [--dir <brain>]",
      "  commonwealth-curate approve <id...> [--dir <brain>]",
      "  commonwealth-curate reject <id...> [--dir <brain>]",
      "  commonwealth-curate approve-all [--dir <brain>]",
      "  commonwealth-curate stage --kind <kind> --title <t> --body <b> [--tags a,b]",
      "      [--deciders a,b] [--status <s>] [--dir <brain>]   (deciders/status: decisions)",
      "  commonwealth-curate context [--dir <brain>] [--cwd <dir>] [--query <q>] [--limit <n>]",
      "  commonwealth-curate capture [--dir <brain>] [--cwd <dir>] [--from <json-file>]",
      "  commonwealth-curate neighbors [--dir <brain>] [--cwd <dir>] [--from <json-file>] [--k <n>]",
      "  commonwealth-curate scope show",
      "  commonwealth-curate scope check [--cwd <dir>]",
      "  commonwealth-curate scope allow <path>",
      "  commonwealth-curate scope deny <path>",
      "  commonwealth-curate health [--dir <brain>]",
      "  commonwealth-curate map [--dir <brain>]",
      "  commonwealth-curate project <list | link <id> <src...> | unlink <id> [<src...>]",
      "      | adopt <id> [--dry-run]> [--dir <brain>]",
      "  commonwealth-curate status-cache [--dir <brain>]",
      "  commonwealth-curate consolidate [--dry-run] [--dir <brain>]",
      "  commonwealth-curate graduate [--suggest] [--dry-run] [--threshold <n>] [--org-dir <brain>] [--include-rejected]",
      "  commonwealth-curate feature list [--dir <brain>]",
      "  commonwealth-curate feature enable <name> [--dir <brain>]",
      "  commonwealth-curate feature disable <name> [--dir <brain>]",
      "",
      `Kinds: ${NOTE_KINDS.join(", ")}`,
    ].join("\n"),
  );
}

/** Type guard: is a string one of the four note kinds? */
function isNoteKind(value: string): value is NoteKind {
  return (NOTE_KINDS as readonly string[]).includes(value);
}

/** Render an LLM-consolidation annotation for a staged note's pending line (ADR-0030), or "". */
function pendingVerdictAnnotation(fm: Record<string, unknown>): string {
  const ids = (key: string): string[] =>
    Array.isArray(fm[key])
      ? (fm[key] as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
  const parts: string[] = [];
  for (const c of ids("contradicts")) parts.push(`⚠ contradicts ${c}`);
  for (const s of ids("supersedes")) parts.push(`↳ supersedes ${s}`);
  return parts.length > 0 ? `  ${parts.join("  ")}` : "";
}

async function cmdList(dir: string): Promise<void> {
  const pending = await listPending(dir);
  for (const note of pending) {
    const fm = note.frontmatter as unknown as Record<string, unknown>;
    const annotation = pendingVerdictAnnotation(fm);
    console.log(
      `${note.frontmatter.id}  [${note.frontmatter.kind}]  ${note.frontmatter.title}${annotation}`,
    );
  }
}

async function cmdApprove(dir: string, ids: string[]): Promise<void> {
  if (ids.length === 0) throw new Error("approve requires at least one <id>");
  for (const id of ids) {
    const canonPath = await approve(dir, id);
    console.log(canonPath);
  }
}

async function cmdReject(dir: string, ids: string[]): Promise<void> {
  if (ids.length === 0) throw new Error("reject requires at least one <id>");
  for (const id of ids) {
    await reject(dir, id);
    console.error(`[commonwealth-curate] rejected ${id}`);
  }
}

async function cmdApproveAll(dir: string): Promise<void> {
  const paths = await approveAll(dir);
  for (const p of paths) console.log(p);
  console.error(`[commonwealth-curate] approved ${paths.length} note(s)`);
}

async function cmdStage(dir: string, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      kind: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      tags: { type: "string" },
      // Decision provenance (ADR-0022): who decided, and the decision's lifecycle status. Stored
      // as kind-specific `fields` on the note (schema-validated); meaningful for `--kind decision`.
      deciders: { type: "string" },
      status: { type: "string" },
      // Tolerated here (handled by the top-level parser) so `--dir` doesn't error.
      dir: { type: "string" },
    },
    allowPositionals: false,
  });

  const { kind, title, body, tags, deciders, status } = values;
  if (!kind || !title || !body) {
    throw new Error("stage requires --kind, --title and --body");
  }
  if (!isNoteKind(kind)) {
    throw new Error(`invalid --kind "${kind}"; expected one of: ${NOTE_KINDS.join(", ")}`);
  }

  const csv = (s: string): string[] =>
    s
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

  // Kind-specific frontmatter fields go in `fields`, validated against the schema on write.
  const fields: Record<string, unknown> = {};
  if (deciders) fields.deciders = csv(deciders);
  if (status) fields.status = status;

  const candidate: NewNoteInput = {
    kind,
    title,
    body,
    ...(tags ? { tags: csv(tags) } : {}),
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
  };

  const contributor = await resolveContributorIdentity(process.cwd());
  if (!contributor) {
    throw new Error("no contributor identity; configure git user.name or set COMMONWEALTH_AUTHOR");
  }
  const attributed = await attributeNoteInputs(dir, [candidate], contributor);
  const result = await curate(dir, attributed.candidates);
  if (result.staged.length > 0) {
    try {
      const person = await ensureContributorPerson(dir, contributor);
      if (person.frontmatter.id !== attributed.personId) {
        for (let index = 0; index < result.staged.length; index += 1) {
          result.staged[index] = await reassignStagedContributor(
            dir,
            result.staged[index]!,
            attributed.personId,
            person.frontmatter.id,
          );
        }
      }
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      for (const note of result.staged) {
        try {
          await reject(dir, note.frontmatter.id);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "contributor creation failed and staged attribution rollback was incomplete",
        );
      }
      throw error;
    }
  }
  for (const note of result.staged) {
    console.log(`${note.frontmatter.id}  [${note.frontmatter.kind}]  ${note.frontmatter.title}`);
  }
  for (const r of result.rejected) {
    const extra = r.duplicateOf ? ` (of ${r.duplicateOf})` : "";
    console.error(`[commonwealth-curate] rejected: ${r.reason}${extra}`);
  }
}

/**
 * `context` — emit relevant team-brain context for the session's cwd (what a SessionStart
 * hook injects). Out-of-scope cwds print nothing and exit 0; diagnostics go to stderr.
 */
async function cmdContext(explicitDir: string | undefined, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: "string" },
      cwd: { type: "string" },
      query: { type: "string" },
      limit: { type: "string" },
    },
    allowPositionals: false,
  });

  const cwd = typeof values.cwd === "string" ? values.cwd : process.cwd();

  // One pass resolves scope AND brain (ADR-0024 §3): out-of-scope (`denied`) or nowhere-configured
  // (`none`) both inject nothing, with a reason on stderr; a routed brain is used directly.
  const resolved = await resolveScopedBrain(explicitDir ?? values.dir, cwd);
  if ("skip" in resolved) {
    const why = resolved.skip === "out-of-scope" ? "is out of scope" : "has no brain";
    console.error(`[commonwealth-curate] ${cwd} ${why}; injecting nothing`);
    return;
  }
  const dir = resolved.brain;

  const limit = values.limit !== undefined ? Number.parseInt(values.limit, 10) : undefined;
  const notes = await selectRelevant(dir, {
    ...(typeof values.query === "string" ? { query: values.query } : {}),
    ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
  });

  const rendered = formatContext(notes);
  if (rendered.length > 0) console.log(rendered);
}

/**
 * Read and validate a candidate array from a JSON string. Each entry is a `NewNoteInput` that may
 * additionally carry an LLM `verdict` (ADR-0030) the hook layer annotated it with; the verdict
 * rides through untouched and is applied by {@link captureCandidates}.
 */
function parseCandidates(raw: string): AnnotatedCandidate[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("capture expects a JSON array of candidate notes");
  }
  return parsed as AnnotatedCandidate[];
}

/** Read all of STDIN as a UTF-8 string. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * `capture` — stage session-proposed candidate notes, but only when the session's cwd is
 * in scope. Out-of-scope cwds (personal projects) are silently skipped (exit 0, no stdout).
 * Candidates come from `--from <json-file>` or STDIN.
 */
async function cmdCapture(explicitDir: string | undefined, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: "string" },
      cwd: { type: "string" },
      from: { type: "string" },
      // Explicit imports (e.g. seeding a chosen repo) bypass the per-session scope gate,
      // which exists to filter out-of-scope *sessions*, not deliberate imports.
      force: { type: "boolean" },
    },
    allowPositionals: false,
  });

  const cwd = typeof values.cwd === "string" ? values.cwd : process.cwd();

  // One pass resolves scope AND brain (ADR-0024 §3). `--force` is the deliberate-import escape
  // hatch: it bypasses the out-of-scope `denied` gate but still needs a brain to write to.
  const resolved = await resolveScopedBrain(explicitDir ?? values.dir, cwd, {
    force: values.force === true,
  });
  if ("skip" in resolved) {
    const why = resolved.skip === "out-of-scope" ? "is out of scope" : "has no brain";
    console.error(`[commonwealth-curate] ${cwd} ${why}; capturing nothing`);
    return;
  }
  const dir = resolved.brain;

  const raw =
    typeof values.from === "string" ? await fs.readFile(values.from, "utf8") : await readStdin();
  const candidates = parseCandidates(raw);

  // Stamp each candidate with its originating project (ADR-0015) from the session cwd, so the
  // note is filed under `<project>/<kind>/`. An explicit per-candidate source is preserved.
  const source = (await resolveProjectSource(cwd)) ?? undefined;
  // Declared engagement IDENTITY (ADR-0031): if a `.commonwealth/project.json` manifest is present
  // at/above the session cwd, stamp its `project` into frontmatter and its `customer` as a
  // `customer:<slug>` tag. Absent → nothing stamped (the alias map or the source-as-singleton
  // fallback resolves identity at read time). An explicit per-candidate `project` is preserved.
  const manifest = await resolveProjectManifest(cwd);
  const stamp = manifest ? manifestStamp(manifest) : null;
  const stamped = candidates.map((c) => {
    const withSource = c.source ? c : { ...c, source };
    if (!stamp) return withSource;
    const project = withSource.project ?? stamp.project;
    const tags =
      stamp.tag && !(withSource.tags ?? []).includes(stamp.tag)
        ? [...(withSource.tags ?? []), stamp.tag]
        : withSource.tags;
    return { ...withSource, project, ...(tags ? { tags } : {}) };
  });

  const contributor = values.force === true ? null : await resolveContributorIdentity(cwd);
  if (values.force !== true && !contributor) {
    throw new Error("no contributor identity; configure git user.name or set COMMONWEALTH_AUTHOR");
  }
  const result = await captureCandidates(
    dir,
    stamped,
    undefined,
    contributor ? { contributor } : {},
  );
  // One stdout line per captured note (the SessionEnd hook counts these lines). When
  // autoPromote landed them in canon we prefix the canonical path; otherwise the staged id.
  // `result.promoted[i]` aligns with `result.staged[i]` (promotion iterates staged in order).
  if (result.promoted.length > 0) {
    result.staged.forEach((note, i) => {
      const canonPath = result.promoted[i] ?? `${note.frontmatter.kind}/${note.frontmatter.id}.md`;
      console.log(`promoted  ${canonPath}  [${note.frontmatter.kind}]  ${note.frontmatter.title}`);
    });
  } else {
    for (const note of result.staged) {
      console.log(`${note.frontmatter.id}  [${note.frontmatter.kind}]  ${note.frontmatter.title}`);
    }
  }
  // Emit the LLM curation verdict summary (ADR-0030) as a machine-readable sentinel line the hook
  // reads to render the receipt ("… 1 superseded older note, 1 flagged contradiction, filtered 2
  // as trivia"). Only when the pass actually did something, so the plain-capture stdout is
  // unchanged for brains without the curator.
  const duplicates = result.rejected.filter((r) => r.reason === "llm-duplicate").length;
  if (
    result.superseded.length > 0 ||
    result.contradictions.length > 0 ||
    result.triviaFiltered > 0 ||
    duplicates > 0 ||
    result.clamped > 0
  ) {
    console.log(
      VERDICT_SUMMARY_PREFIX +
        JSON.stringify({
          superseded: result.superseded.length,
          contradicted: result.contradictions.length,
          trivia: result.triviaFiltered,
          duplicate: duplicates,
          clamped: result.clamped,
        }),
    );
  }
  for (const r of result.rejected) {
    const extra = r.duplicateOf ? ` (of ${r.duplicateOf})` : "";
    console.error(`[commonwealth-curate] rejected: ${r.reason}${extra}`);
  }
}

/**
 * `neighbors --from <json>|stdin [--k <n>] [--cwd <dir>]` — the DETERMINISTIC, offline first step
 * of the LLM curation pass (ADR-0030). For each candidate note it emits the top-`k` nearest CANON
 * notes (vectors when a provider + index are present, else lexical Jaccard — no model call), so the
 * plugin hook can hand candidate+neighbor context to ONE batched classifier. Also reports the
 * `llmCurator` flag as `enabled`, so the hook skips classification entirely when the brain has the
 * feature off. Output is a single JSON object on stdout; diagnostics go to stderr.
 */
async function cmdNeighbors(explicitDir: string | undefined, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: "string" },
      cwd: { type: "string" },
      from: { type: "string" },
      k: { type: "string" },
    },
    allowPositionals: false,
  });

  const cwd = typeof values.cwd === "string" ? values.cwd : process.cwd();
  const resolved = await resolveScopedBrain(explicitDir ?? values.dir, cwd);
  if ("skip" in resolved) {
    // Out of scope / no brain: nothing to classify. Report disabled so the hook does no work.
    console.log(JSON.stringify({ enabled: false, candidates: [] }));
    return;
  }
  const dir = resolved.brain;

  const raw =
    typeof values.from === "string" ? await fs.readFile(values.from, "utf8") : await readStdin();
  const candidates = parseCandidates(raw);
  const k = values.k !== undefined ? Number.parseInt(values.k, 10) : undefined;
  const result = await computeNeighbors(dir, candidates, {
    ...(k !== undefined && Number.isFinite(k) && k > 0 ? { k } : {}),
  });
  console.log(JSON.stringify(result));
}

/** `scope <show|check|allow|deny>` — inspect and edit the per-user scope filter. */
async function cmdScope(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "show": {
      const config = await loadUserConfig();
      console.log(JSON.stringify(config, null, 2));
      return;
    }
    case "check": {
      const { values } = parseArgs({
        args: rest,
        options: { cwd: { type: "string" } },
        allowPositionals: false,
      });
      const cwd = typeof values.cwd === "string" ? values.cwd : process.cwd();
      // Scope IS resolution now (ADR-0024 §3): in scope ⟺ the cwd resolves to a brain. A `denied`
      // rule or a `none` (nothing configured) is out of scope.
      const resolution = await resolveBrain(cwd);
      console.log(resolution.kind === "brain" ? "in-scope" : "out-of-scope");
      return;
    }
    case "allow": {
      const target = rest[0];
      if (!target) throw new Error("scope allow requires a <path>");
      const resolved = await addAllow(target);
      console.error(`[commonwealth-curate] allow += ${target}`);
      // Allowed-but-unmapped is a dead state (#157): scope only gates WHETHER capture may
      // happen; the registry decides WHICH brain a folder writes to. When the newly allowed
      // path resolves to no brain, capture there still silently does nothing — warn instead
      // of letting the user assume this command wired the folder up.
      if ((await resolveBrainDir(resolved)) === null) {
        console.error(
          `[commonwealth-curate] WARNING: ${resolved} resolves to no brain — capture is now ` +
            `allowed here but will do nothing. Wire it with \`commonwealth add ${target}\` ` +
            `(or \`commonwealth init\`).`,
        );
      }
      return;
    }
    case "deny": {
      const target = rest[0];
      if (!target) throw new Error("scope deny requires a <path>");
      await addDeny(target);
      console.error(`[commonwealth-curate] deny += ${target}`);
      return;
    }
    default:
      throw new Error(`unknown scope subcommand "${sub ?? ""}"; expected show|check|allow|deny`);
  }
}

/**
 * `feature <list|enable|disable> [name]` — inspect and toggle brain-level feature flags
 * (ADR-0009). Flags live in the shared, synced `<brain>/.commonwealth/config.json`, so they
 * apply to the whole team. `list` prints each known flag with its current on/off state;
 * `enable`/`disable` validate the name against {@link FEATURE_FLAGS} then persist.
 */
async function cmdFeature(dir: string, args: string[]): Promise<void> {
  // `--dir` is handled by the top-level parser; drop it (and its value) so the remaining
  // positionals are just the subcommand and flag name.
  const { positionals } = parseArgs({
    args,
    options: { dir: { type: "string" } },
    allowPositionals: true,
    strict: false,
  });
  const [sub, ...rest] = positionals;
  switch (sub) {
    case "list": {
      const config = await loadBrainConfig(dir);
      for (const flag of FEATURE_FLAGS) {
        const state = config.features[flag.name] ? "on" : "off";
        console.log(`${flag.name}  [${state}]  — ${flag.description}`);
      }
      return;
    }
    case "enable":
    case "disable": {
      const name = rest[0];
      if (!name) throw new Error(`feature ${sub} requires a <name>`);
      if (!FEATURE_FLAGS.some((f) => f.name === name)) {
        const known = FEATURE_FLAGS.map((f) => f.name).join(", ");
        throw new Error(`unknown feature "${name}"; expected one of: ${known}`);
      }
      const on = sub === "enable";
      await setFeature(dir, name, on);
      console.error(`[commonwealth-curate] feature ${name} ${on ? "enabled" : "disabled"}`);
      return;
    }
    default:
      throw new Error(`unknown feature subcommand "${sub ?? ""}"; expected list|enable|disable`);
  }
}

/**
 * `health` — brain-health / trust rollup (#109): a freshness/trust score plus counts of stale,
 * unverified, contradicted, and orphaned notes. Read-only; prints a human summary to stdout.
 */
async function cmdHealth(dir: string): Promise<void> {
  const h = await computeBrainHealth(dir);
  console.log(`Brain health: ${h.score}/100  (${h.total} note${h.total === 1 ? "" : "s"})`);
  console.log(`  stale:        ${h.stale.count}`);
  console.log(`  unverified:   ${h.unverified.count}`);
  console.log(`  contradicted: ${h.contradicted.count}`);
  console.log(`  orphaned:     ${h.orphaned.count}`);

  // Per-resolved-project rollup (ADR-0031): linked sources roll up as one engagement. Shown only
  // when more than one project is present, so a single-project brain's output is unchanged.
  const byProject = await computeHealthByProject(dir);
  if (byProject.length > 1) {
    console.log("By project:");
    const width = Math.max(...byProject.map((p) => p.project.length));
    for (const { project, report } of byProject) {
      console.log(
        `  ${project.padEnd(width)}  ${report.score}/100  (${report.total} note${report.total === 1 ? "" : "s"})`,
      );
    }
  }
}

/** Longest per-kind bar, in `█` chars, at the highest-count kind. Shorter bars scale down. */
const MAP_BAR_WIDTH = 24;

/** Render an `n`-of-`max` bar as `█`s scaled to {@link MAP_BAR_WIDTH}; a positive count is ≥1 cell. */
function bar(n: number, max: number): string {
  if (n <= 0 || max <= 0) return "";
  return "█".repeat(Math.max(1, Math.round((n / max) * MAP_BAR_WIDTH)));
}

/**
 * `map` — brain-at-a-glance coverage overview (#205): per-kind counts (with ASCII bars) and top
 * contributors, plus the {@link brainHealth} trust score on the headline. The brain is otherwise
 * invisible (the derived index is agent-facing); this is the "what does it hold?" surface.
 * Read-only; prints a human summary to stdout. Notes are loaded once and fed to both pure rollups.
 */
async function cmdMap(dir: string): Promise<void> {
  const notes = await listNotes(dir);
  const m = brainMap(notes);
  const { score } = brainHealth(notes);

  if (m.total === 0) {
    console.log("Brain map: empty — no notes captured yet.");
    return;
  }

  console.log(`Brain map: ${m.total} note${m.total === 1 ? "" : "s"}  ·  health ${score}/100`);
  const kindLabelWidth = Math.max(...m.byKind.map((k) => k.kind.length));
  const kindCountWidth = Math.max(...m.byKind.map((k) => String(k.count).length));
  const maxKind = Math.max(...m.byKind.map((k) => k.count));
  for (const { kind, count } of m.byKind) {
    const label = kind.padEnd(kindLabelWidth);
    const num = String(count).padStart(kindCountWidth);
    console.log(`  ${label}  ${num}  ${bar(count, maxKind)}`.trimEnd());
  }

  console.log("Contributors:");
  const authorWidth = Math.max(...m.contributors.map((c) => c.author.length));
  for (const { author, count } of m.contributors) {
    console.log(`  ${author.padEnd(authorWidth)}  ${count}`);
  }
}

/**
 * `project` — curate the brain's project alias map (ADR-0031): the explicit, versioned linking of
 * capture `source`s into one engagement identity. Subcommands:
 *   - `list`                             — print the map (project id → customer? + member sources).
 *   - `link   <projectId> <source...>`   — add sources to a project (creating it), then regenerate.
 *   - `unlink <projectId> [<source...>]` — remove sources (all if none given), then regenerate.
 *   - `adopt  <projectId> [--dry-run]`   — stamp the resolved identity onto the linked historical
 *     notes' frontmatter in one commit, then retire the redundant alias entry (ADR-0031, #241).
 *
 * Writes go through the guarded {@link persistProjectAliasMap} (refuses to clobber a corrupt map),
 * and every mutation regenerates the derived router + index so the grouping updates atomically with
 * the map — linking is retroactive and touches no note file (confirmation over inference: never a
 * fuzzy auto-merge). Returns a process exit code.
 */
async function cmdProject(dir: string, args: string[]): Promise<number> {
  // `args` still carries the shared `--dir <brain>` (peeled off for VALUE in main but not removed
  // from the arg list). Re-parse to drop it, so only the real positionals reach the subcommand.
  const { positionals } = parseArgs({
    args,
    options: { dir: { type: "string" } },
    allowPositionals: true,
    strict: false,
  });
  const [sub, ...rest] = positionals;

  if (!sub || sub === "list") {
    const map = await loadProjectAliasMap(dir);
    const ids = Object.keys(map).sort();
    if (ids.length === 0) {
      console.log("No project links yet. Use `commonwealth project link <projectId> <source...>`.");
      return 0;
    }
    for (const id of ids) {
      const entry = map[id]!;
      const customer = entry.customer ? `  (customer: ${entry.customer})` : "";
      console.log(`${id}${customer}`);
      for (const s of [...entry.sources].sort()) console.log(`  - ${s}`);
    }
    return 0;
  }

  if (sub === "link") {
    const [projectId, ...sources] = rest;
    if (!projectId || sources.length === 0) {
      console.error("usage: commonwealth project link <projectId> <source...>");
      return 2;
    }
    // Ingestion hardening (#241): a link creates a project id the adopt path may later stamp onto
    // hundreds of notes — reject a pathological value here, before it enters the map.
    const idErr = projectIdError(projectId);
    if (idErr) {
      console.error(`Invalid project id: ${idErr}`);
      return 2;
    }
    await persistProjectAliasMap(dir, (map) => linkSources(map, projectId, sources));
    await buildIndex(dir);
    await regenerateDerived(dir);
    console.log(`Linked ${sources.length} source(s) into "${projectId}".`);
    return 0;
  }

  if (sub === "unlink") {
    const [projectId, ...sources] = rest;
    if (!projectId) {
      console.error("usage: commonwealth project unlink <projectId> [<source...>]");
      return 2;
    }
    const current = await loadProjectAliasMap(dir);
    const entry = current[projectId];
    if (!entry) {
      console.error(`No such project "${projectId}".`);
      return 1;
    }
    // No sources given → unlink the whole project (all its sources).
    const toRemove = sources.length > 0 ? sources : entry.sources;
    await persistProjectAliasMap(dir, (map) => unlinkSources(map, projectId, toRemove));
    await buildIndex(dir);
    await regenerateDerived(dir);
    console.log(`Unlinked ${toRemove.length} source(s) from "${projectId}".`);
    return 0;
  }

  if (sub === "adopt") {
    const projectId = rest[0];
    if (!projectId) {
      console.error("usage: commonwealth project adopt <projectId> [--dry-run]");
      return 2;
    }
    const idErr = projectIdError(projectId);
    if (idErr) {
      console.error(`Invalid project id: ${idErr}`);
      return 2;
    }
    // `--dry-run` is a flag, not a positional; re-parse `args` to read it (the outer parse dropped
    // unknown options into `values`, but reading it explicitly here keeps the intent local).
    const { values } = parseArgs({
      args,
      options: { dir: { type: "string" }, "dry-run": { type: "boolean" } },
      allowPositionals: true,
      strict: false,
    });
    const result = await adoptProject(dir, projectId, { dryRun: values["dry-run"] === true });
    return renderAdopt(result);
  }

  console.error(`Unknown project subcommand: ${sub}`);
  console.error("usage: commonwealth project <list | link | unlink | adopt>");
  return 2;
}

/** Render an {@link AdoptResult} to stdout (summary) / stderr (refusals); returns the exit code. */
function renderAdopt(result: AdoptResult): number {
  if (result.skipped) {
    console.error(`[commonwealth-curate] adopt skipped: ${result.skipped}`);
    return 1;
  }

  const label = result.customer
    ? `"${result.project}"  (customer: ${result.customer})`
    : `"${result.project}"`;
  const total = result.adopted.length;

  if (result.dryRun) {
    console.log(`Dry run — no changes written. Adopt ${label}:`);
  } else if (result.committed) {
    console.log(`Adopted ${label} onto ${total} note(s); committed ${result.commit}.`);
  } else {
    console.log(
      `Adopted ${label} onto ${total} note(s) (no commit — non-git brain or no changes).`,
    );
  }

  for (const s of result.perSource) {
    const verb = result.dryRun ? "would stamp" : "stamped";
    const parts = [`${verb} ${s.adopted}`];
    if (s.conflicts > 0) parts.push(`${s.conflicts} conflict(s)`);
    if (s.staged > 0) parts.push(`${s.staged} staged (not adopted)`);
    console.log(`  ${s.source}: ${parts.join(", ")}`);
  }

  if (result.conflicts.length > 0) {
    console.log("Conflicts (declare a different project — left untouched, need review):");
    for (const c of result.conflicts) {
      console.log(`  ${c.id}  ${c.path}  currently project=${c.existingProject}`);
    }
  }

  if (!result.dryRun) {
    if (result.entryRemoved) {
      console.log("Removed the now-redundant alias entry.");
    } else if (result.keptSources.length > 0) {
      console.log(
        `Kept alias entry (sources with no adopted notes): ${result.keptSources.join(", ")}`,
      );
    }
  }

  return 0;
}

/**
 * `status-cache` — refresh the ambient status cache for a brain (#197). Computes the freshness
 * score + pending-review count and persists them to the per-user cache the `statusLine` reader
 * consumes. This is the OFF-hot-path writer: the SessionEnd worker invokes it (with the resolved
 * brain in `$COMMONWEALTH_BRAIN_DIR`) so the index work happens in the background, never in the
 * per-turn statusline render. Diagnostics to stderr; nothing on stdout.
 */
async function cmdStatusCache(dir: string): Promise<void> {
  const s = await refreshBrainStatus(dir, Date.now());
  console.error(
    `[commonwealth-curate] status cached for ${s.brain}: ${s.score}/100, ${s.pending} pending`,
  );
}

/**
 * `consolidate [--dry-run]` — cross-user canon consolidation (#29): supersede near-duplicate
 * memory/decision notes onto a single survivor (supersede-not-delete), single-writer.
 */
async function cmdConsolidate(dir: string, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { "dry-run": { type: "boolean" }, dir: { type: "string" } },
    allowPositionals: false,
  });
  const result = await consolidateCanon(dir, { dryRun: values["dry-run"] === true });
  if (result.skipped) {
    console.error(`[commonwealth-curate] consolidate skipped: ${result.skipped}`);
    return;
  }
  const verb = values["dry-run"] ? "would supersede" : "superseded";
  console.error(
    `[commonwealth-curate] ${result.clusters} duplicate cluster(s); ${verb} ${result.superseded.length} note(s)`,
  );
  for (const s of result.superseded) console.log(`${s.id} -> ${s.survivor}`);
}

/**
 * `graduate [--suggest] [--dry-run] [--threshold <n>] [--org-dir <brain>]` — org-brain graduation
 * (#110): scan every wired project brain for opted-in notes that recur across ≥2 brains and stage
 * a candidate into the org-brain for manual review. Unlike other subcommands it resolves NO single
 * brain from cwd — it locates the org-brain (from `--org-dir` or the registry pointer) and
 * enumerates the rest itself. `--suggest` is accepted for ergonomics (the only mode is suggest).
 */
async function cmdGraduate(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      suggest: { type: "boolean" },
      "dry-run": { type: "boolean" },
      threshold: { type: "string" },
      "org-dir": { type: "string" },
      "include-rejected": { type: "boolean" },
    },
    allowPositionals: false,
  });
  const threshold = values.threshold !== undefined ? Number(values.threshold) : undefined;
  if (threshold !== undefined && (Number.isNaN(threshold) || threshold <= 0 || threshold > 1)) {
    console.error("[commonwealth-curate] graduate: --threshold must be a number in (0, 1]");
    process.exitCode = 1;
    return;
  }
  const result = await graduateToOrgBrain({
    dryRun: values["dry-run"] === true,
    includeRejected: values["include-rejected"] === true,
    ...(threshold !== undefined ? { threshold } : {}),
    ...(typeof values["org-dir"] === "string" ? { orgBrainDir: values["org-dir"] } : {}),
  });
  if (result.skipped) {
    console.error(`[commonwealth-curate] graduate skipped: ${result.skipped}`);
    return;
  }
  for (const s of result.skippedBrains) {
    console.error(`[commonwealth-curate] graduate: skipped brain ${s.brain}: ${s.reason}`);
  }
  const verb = values["dry-run"] ? "would stage" : "staged";
  console.error(
    `[commonwealth-curate] ${result.clusters} cross-brain cluster(s); ${verb} ` +
      `${values["dry-run"] ? result.candidates.length : result.staged.length} candidate(s)` +
      (result.rejected.length > 0 ? `; ${result.rejected.length} rejected by gate` : "") +
      (result.suppressed > 0 ? ` (previously rejected — ${result.suppressed} suppressed)` : ""),
  );
  // stdout: one line per candidate — `<kind>  <title>  <- src1, src2` — composable with other tools.
  for (const c of result.candidates) {
    console.log(`${c.kind}\t${c.title}\t<- ${c.sources.join(", ")}`);
  }
}

/**
 * `commonwealth-curate` CLI entry (ADR-0007). Diagnostics go to stderr; approved/staged paths
 * and ids go to stdout so they compose with other tools. NO shebang here — tsup's banner
 * supplies it; a source shebang would break the built binary.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [command, ...rest] = argv;

  // Runtime health contract used by the plugin's exact-path probe (`commonwealth doctor`, #222).
  // Keep this brain-independent and side-effect-free so it works even when capture wiring is broken.
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(packageJson.version);
    return;
  }

  // Peel off a shared `--dir` from the remaining args; the rest are command-specific.
  const { values, positionals } = parseArgs({
    args: rest,
    options: { dir: { type: "string" } },
    allowPositionals: true,
    // Leave unknown options (e.g. stage's --kind) for the subcommand parser.
    strict: false,
  });
  const explicitDir = typeof values.dir === "string" ? values.dir : undefined;
  // Brain-requiring commands resolve from the process cwd via the registry; a missing brain is
  // a clear error rather than a silent fall-through to cwd (#69). `context`/`capture` resolve
  // from their own `--cwd` (the session dir), and `scope` needs no brain at all.
  const requireBrain = async (): Promise<string> =>
    (await resolveDir(explicitDir)) ?? noBrain(process.cwd());

  switch (command) {
    case "list":
      await cmdList(await requireBrain());
      break;
    case "approve":
      await cmdApprove(await requireBrain(), positionals);
      break;
    case "reject":
      await cmdReject(await requireBrain(), positionals);
      break;
    case "approve-all":
      await cmdApproveAll(await requireBrain());
      break;
    case "stage":
      // stage owns its own flags; re-parse the original rest (minus --dir handled above).
      await cmdStage(await requireBrain(), rest);
      break;
    case "context":
      await cmdContext(explicitDir, rest);
      break;
    case "capture":
      await cmdCapture(explicitDir, rest);
      break;
    case "neighbors":
      await cmdNeighbors(explicitDir, rest);
      break;
    case "scope":
      await cmdScope(rest);
      break;
    case "feature":
      await cmdFeature(await requireBrain(), rest);
      break;
    case "health":
      await cmdHealth(await requireBrain());
      break;
    case "map":
      await cmdMap(await requireBrain());
      break;
    case "project":
      process.exitCode = await cmdProject(await requireBrain(), rest);
      break;
    case "status-cache":
      await cmdStatusCache(await requireBrain());
      break;
    case "consolidate":
      await cmdConsolidate(await requireBrain(), rest);
      break;
    case "graduate":
      // No requireBrain(): graduate locates the org-brain + wired brains itself.
      await cmdGraduate(rest);
      break;
    default:
      usage();
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((err: unknown) => {
  console.error("[commonwealth-curate] error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
