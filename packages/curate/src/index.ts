import path from "node:path";
import { promises as fs } from "node:fs";
import { parseArgs } from "node:util";
import {
  computeBrainHealth,
  FEATURE_FLAGS,
  loadBrainConfig,
  type NewNoteInput,
  NOTE_KINDS,
  type NoteKind,
  resolveBrainDir,
  resolveProjectSource,
  setFeature,
} from "@cmnwlth/core";
import { captureCandidates } from "./capture.js";
import { consolidateCanon } from "./consolidate.js";
import { formatContext } from "./context.js";
import { curate } from "./curate.js";
import { selectRelevant } from "./relevance.js";
import { approve, approveAll, listPending, reject } from "./review.js";
import { addAllow, addDeny, isInScope, loadUserConfig } from "./scope.js";

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
      "  commonwealth-curate stage --kind <kind> --title <t> --body <b> [--tags a,b] [--dir <brain>]",
      "  commonwealth-curate context [--dir <brain>] [--cwd <dir>] [--query <q>] [--limit <n>]",
      "  commonwealth-curate capture [--dir <brain>] [--cwd <dir>] [--from <json-file>]",
      "  commonwealth-curate scope show",
      "  commonwealth-curate scope check [--cwd <dir>]",
      "  commonwealth-curate scope allow <path>",
      "  commonwealth-curate scope deny <path>",
      "  commonwealth-curate health [--dir <brain>]",
      "  commonwealth-curate consolidate [--dry-run] [--dir <brain>]",
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

async function cmdList(dir: string): Promise<void> {
  const pending = await listPending(dir);
  for (const note of pending) {
    console.log(`${note.frontmatter.id}  [${note.frontmatter.kind}]  ${note.frontmatter.title}`);
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
      // Tolerated here (handled by the top-level parser) so `--dir` doesn't error.
      dir: { type: "string" },
    },
    allowPositionals: false,
  });

  const { kind, title, body, tags } = values;
  if (!kind || !title || !body) {
    throw new Error("stage requires --kind, --title and --body");
  }
  if (!isNoteKind(kind)) {
    throw new Error(`invalid --kind "${kind}"; expected one of: ${NOTE_KINDS.join(", ")}`);
  }

  const candidate: NewNoteInput = {
    kind,
    title,
    body,
    ...(tags
      ? {
          tags: tags
            .split(",")
            .map((t) => t.trim())
            .filter((t) => t.length > 0),
        }
      : {}),
  };

  const result = await curate(dir, [candidate]);
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
  const config = await loadUserConfig();
  if (!isInScope(cwd, config)) {
    console.error(`[commonwealth-curate] ${cwd} is out of scope; injecting nothing`);
    return;
  }

  // Resolve the brain from the session cwd via the registry (#69); no brain → inject nothing.
  const dir = await resolveDir(explicitDir ?? values.dir, cwd);
  if (dir === null) {
    console.error(`[commonwealth-curate] no brain for ${cwd}; injecting nothing`);
    return;
  }

  const limit = values.limit !== undefined ? Number.parseInt(values.limit, 10) : undefined;
  const notes = await selectRelevant(dir, {
    ...(typeof values.query === "string" ? { query: values.query } : {}),
    ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
  });

  const rendered = formatContext(notes);
  if (rendered.length > 0) console.log(rendered);
}

/** Read and validate a candidate array (`NewNoteInput[]`) from a JSON string. */
function parseCandidates(raw: string): NewNoteInput[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("capture expects a JSON array of candidate notes");
  }
  return parsed as NewNoteInput[];
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
  if (!values.force) {
    const config = await loadUserConfig();
    if (!isInScope(cwd, config)) {
      console.error(`[commonwealth-curate] ${cwd} is out of scope; capturing nothing`);
      return;
    }
  }

  // Resolve the brain from the session cwd via the registry (#69); no brain → capture nothing.
  const dir = await resolveDir(explicitDir ?? values.dir, cwd);
  if (dir === null) {
    console.error(`[commonwealth-curate] no brain for ${cwd}; capturing nothing`);
    return;
  }

  const raw =
    typeof values.from === "string" ? await fs.readFile(values.from, "utf8") : await readStdin();
  const candidates = parseCandidates(raw);

  // Stamp each candidate with its originating project (ADR-0015) from the session cwd, so the
  // note is filed under `<project>/<kind>/`. An explicit per-candidate source is preserved.
  const source = (await resolveProjectSource(cwd)) ?? undefined;
  const stamped = candidates.map((c) => (c.source ? c : { ...c, source }));

  const result = await captureCandidates(dir, stamped);
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
  for (const r of result.rejected) {
    const extra = r.duplicateOf ? ` (of ${r.duplicateOf})` : "";
    console.error(`[commonwealth-curate] rejected: ${r.reason}${extra}`);
  }
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
      const config = await loadUserConfig();
      console.log(isInScope(cwd, config) ? "in-scope" : "out-of-scope");
      return;
    }
    case "allow": {
      const target = rest[0];
      if (!target) throw new Error("scope allow requires a <path>");
      await addAllow(target);
      console.error(`[commonwealth-curate] allow += ${target}`);
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
 * `commonwealth-curate` CLI entry (ADR-0007). Diagnostics go to stderr; approved/staged paths
 * and ids go to stdout so they compose with other tools. NO shebang here — tsup's banner
 * supplies it; a source shebang would break the built binary.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [command, ...rest] = argv;

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
    case "scope":
      await cmdScope(rest);
      break;
    case "feature":
      await cmdFeature(await requireBrain(), rest);
      break;
    case "health":
      await cmdHealth(await requireBrain());
      break;
    case "consolidate":
      await cmdConsolidate(await requireBrain(), rest);
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
