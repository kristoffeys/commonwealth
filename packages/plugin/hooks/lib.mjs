// The testable core of the Commonwealth Claude Code hooks. Everything the hooks need from the
// outside world (brain resolution, the scope gate, context injection, capture, and
// candidate extraction) is passed in as `deps` so unit tests can drive the control flow
// without a real brain, a real `claude` binary, or an LLM. `realDeps()` supplies the
// production wiring (see the bottom of this file).
//
// This file is plain ESM `.mjs`: the hooks run it via `node <file>` with no build step, so
// it must not use TypeScript syntax. Tests import it directly.
//
// Contract for `deps` (all async unless noted):
//   resolveBrainDir(cwd)               -> string | null   (which brain maps to this cwd)
//   isInScope(cwd)                     -> boolean          (per-user scope gate, ADR-0008)
//   getContext(brain, cwd)             -> string           (markdown to inject; "" for none)
//   extractCandidates(transcriptPath)  -> NewNoteInput[]   (learnings/decisions from a session)
//   capture(brain, cwd, candidates)    -> { captured, ... }(stage candidates via the review queue)

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * SessionStart: resolve the brain for the session's cwd, honor the per-user scope gate,
 * and return the markdown context string to inject. Returns "" (inject nothing) when there
 * is no brain for this cwd or the cwd is out of scope — the two gates that make an
 * out-of-scope or brain-less session do NOTHING.
 *
 * @param {{ cwd: string }} input  Parsed SessionStart hook stdin.
 * @param {object} deps            See the contract at the top of this file.
 * @returns {Promise<string>}      Context markdown to print to stdout, or "".
 */
export async function sessionStart(input, deps) {
  const cwd = input?.cwd;
  if (typeof cwd !== "string" || cwd.length === 0) return "";

  const brain = await deps.resolveBrainDir(cwd);
  if (!brain) return "";

  if (!(await deps.isInScope(cwd))) return "";

  const context = await deps.getContext(brain, cwd);
  return typeof context === "string" ? context : "";
}

/**
 * SessionEnd: resolve the brain, honor the scope gate, extract candidate notes from the
 * session transcript, and stage them via the review queue (capture). Out-of-scope or
 * brain-less sessions do NOTHING (they never extract candidates or capture). A session with
 * no candidates reports `{ captured: 0 }`.
 *
 * @param {{ cwd: string, transcript_path?: string }} input  Parsed SessionEnd hook stdin.
 * @param {object} deps                                       See the contract above.
 * @returns {Promise<object>}  A small result object for the hook to log to stderr.
 */
export async function sessionEnd(input, deps) {
  const cwd = input?.cwd;
  if (typeof cwd !== "string" || cwd.length === 0) return { skipped: true };

  const brain = await deps.resolveBrainDir(cwd);
  if (!brain) return { skipped: true };

  if (!(await deps.isInScope(cwd))) return { skipped: true };

  const candidates = await deps.extractCandidates(input.transcript_path);
  if (!Array.isArray(candidates) || candidates.length === 0) return { captured: 0 };

  return await deps.capture(brain, cwd, candidates);
}

/**
 * Derive a short, user-facing "value receipt" from injected context. Parses the
 * `## Team brain — N relevant note(s)` heading (curate's formatContext) to report the count.
 * When context is non-empty but lacks that heading/count, falls back to a generic message.
 * Pure function.
 *
 * @param {string} context  The markdown context injected by {@link sessionStart}.
 * @returns {string}        A one-line receipt to show the user.
 */
export function deriveReceipt(context) {
  const text = typeof context === "string" ? context : "";
  const match = text.match(/## Team brain — (\d+) relevant note\(s\)/);
  if (match) return `📖 Loaded ${match[1]} note(s) from your team brain.`;
  return "📖 Loaded relevant context from your team brain.";
}

/**
 * Build the SessionStart hook's stdout payload. Returns `null` when there is no context to
 * inject (empty/whitespace), so the hook writes nothing. Otherwise returns the JSON shape
 * Claude Code expects: `additionalContext` is injected into the model and `systemMessage`
 * (the value receipt) is shown to the user. Pure function.
 *
 * @param {string} context  The markdown context from {@link sessionStart}.
 * @returns {{ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: string }, systemMessage: string } | null}
 */
export function buildSessionStartOutput(context) {
  if (typeof context !== "string" || context.trim().length === 0) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
    systemMessage: deriveReceipt(context),
  };
}

// ---------------------------------------------------------------------------------------
// Production dependencies. These are only imported/used at runtime by the real hooks, never
// by the unit tests (which inject fakes), so importing this module is cheap and side-effect
// free until `realDeps()` is called.
// ---------------------------------------------------------------------------------------

/**
 * The prompt handed to `claude -p` to turn a session transcript into capture candidates.
 * It must return ONLY a JSON array of `NewNoteInput` objects (kind/title/body[/tags]).
 * `decision`-kind candidates are only ever staged when the team has enabled the `autoAdr`
 * feature flag (curate enforces this, ADR-0009), so extraction may propose them freely.
 */
const EXTRACTION_PROMPT = [
  "You are the Commonwealth capture agent. Read the attached Claude Code session transcript and",
  "extract durable team knowledge worth remembering: memories (facts/how-tos), work-state",
  "(what's in progress), people notes, and — only if a real decision was made — decisions.",
  "",
  "Output ONLY a JSON array (no prose, no code fence) of objects shaped:",
  '  { "kind": "memory|work-state|decision|people", "title": string, "body": string, "tags"?: string[] }',
  "Skip trivia, secrets, and anything ephemeral. If nothing is worth capturing, output [].",
].join("\n");

/**
 * Run a command, resolving with `{ code, stdout, stderr }`. Never rejects — a missing
 * binary or non-zero exit is reported via `code` (or `code: null` + `error`). `input`, if
 * given, is written to the child's stdin. Lazy-imports `node:child_process` so importing
 * this module stays side-effect free for tests.
 */
async function run(cmd, args, { input, cwd, env } = {}) {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: String(error), error });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (error) => {
      resolve({ code: null, stdout, stderr: stderr + String(error), error });
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
    if (typeof input === "string") {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

/**
 * Build the production `deps` for the hooks.
 *
 * - `resolveBrainDir` comes from `@commonwealth/core`'s brain registry (issue #14).
 * - `isInScope` shells out to the vendored `commonwealth-curate scope check` so the plugin is
 *   self-contained (no direct import of curate internals) and honors ADR-0008 exactly as
 *   the CLI does.
 * - `getContext` / `capture` spawn the vendored `commonwealth-curate` binary (`context` /
 *   `capture --from -`) with `COMMONWEALTH_BRAIN_DIR` set to the resolved brain — reusing all of
 *   curate's real work (relevance selection, dedupe, scope, autoAdr gate).
 * - `extractCandidates` shells out to `claude -p` with {@link EXTRACTION_PROMPT} and parses
 *   the JSON array it prints; if `claude` is unavailable or the output is not a JSON array,
 *   it returns `[]` gracefully (capture then reports `captured: 0`).
 *
 * @param {object} [overrides]  Optional path overrides for the vendored binaries / node.
 * @returns {object}            The `deps` object matching the contract at the top.
 */
export function realDeps(overrides = {}) {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? new URL("..", import.meta.url).pathname;
  const curateEntry =
    overrides.curateEntry ??
    `${pluginRoot}${pluginRoot.endsWith("/") ? "" : "/"}vendor/curate/index.js`;
  const nodeBin = overrides.nodeBin ?? process.execPath;
  const claudeBin = overrides.claudeBin ?? "claude";

  /** Read + parse the vendored user config indirectly via `scope check`. */
  async function isInScope(cwd) {
    const res = await run(nodeBin, [curateEntry, "scope", "check", "--cwd", cwd]);
    // `scope check` prints "in-scope" / "out-of-scope" to stdout. Be conservative: if the
    // binary is missing or errors, treat the session as out of scope (do nothing) rather
    // than risk capturing/injecting where the user didn't opt in.
    if (res.code !== 0) return false;
    return res.stdout.trim() === "in-scope";
  }

  async function getContext(brain, cwd) {
    const res = await run(nodeBin, [curateEntry, "context", "--cwd", cwd], {
      env: { COMMONWEALTH_BRAIN_DIR: brain },
    });
    if (res.code !== 0) return "";
    return res.stdout.trimEnd();
  }

  async function capture(brain, cwd, candidates) {
    // Pipe candidates on plain stdin: curate's `capture` reads stdin when `--from` is
    // absent. (`--from -` would be treated as a literal file path and fail.)
    const res = await run(nodeBin, [curateEntry, "capture", "--cwd", cwd], {
      input: JSON.stringify(candidates),
      env: { COMMONWEALTH_BRAIN_DIR: brain },
    });
    // `capture` prints one line per staged note to stdout; count them for the summary.
    const staged = res.code === 0 ? res.stdout.split("\n").filter((l) => l.trim().length > 0) : [];
    return { captured: staged.length, staged };
  }

  async function extractCandidates(transcriptPath) {
    if (typeof transcriptPath !== "string" || transcriptPath.length === 0) return [];
    const { promises: fs } = await import("node:fs");
    let transcript;
    try {
      transcript = await fs.readFile(transcriptPath, "utf8");
    } catch {
      return [];
    }
    const prompt = `${EXTRACTION_PROMPT}\n\n--- TRANSCRIPT (JSONL) ---\n${transcript}`;
    const res = await run(claudeBin, ["-p", prompt]);
    if (res.code !== 0) return []; // `claude` unavailable or errored → capture nothing.
    return parseCandidateArray(res.stdout);
  }

  return {
    resolveBrainDir: realResolveBrainDir,
    isInScope,
    getContext,
    capture,
    extractCandidates,
  };
}

// --- Inlined brain registry (mirrors @commonwealth/core/src/registry.ts) --------------------
// Inlined as pure fs/path JS rather than `import("@commonwealth/core")`: the hooks run as
// standalone .mjs where a bare specifier isn't resolvable at runtime, which would make
// every session silently do nothing. Keep in sync with packages/core/src/registry.ts.

const MARKER_REL = path.join(".commonwealth", "brain");
const BRAIN_CONFIG_REL = path.join(".commonwealth", "config.json");

function expandPath(entry, base) {
  const home = os.homedir();
  if (entry === "~") return path.resolve(home);
  if (entry.startsWith("~/")) return path.resolve(home, entry.slice(2));
  return base ? path.resolve(base, entry) : path.resolve(entry);
}

/** Boundary-safe containment: `/work` does not contain `/workshop`. */
function isUnder(child, parent) {
  if (parent === path.sep) return true;
  return child === parent || child.startsWith(parent + path.sep);
}

function* walkUp(startDir) {
  let current = path.resolve(startDir);
  for (;;) {
    yield current;
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function readFileOrNull(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function isFile(file) {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

async function isDir(dir) {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

function resolveRegistryPath() {
  if (process.env.COMMONWEALTH_REGISTRY) return process.env.COMMONWEALTH_REGISTRY;
  if (process.env.COMMONWEALTH_CONFIG) {
    return path.join(path.dirname(process.env.COMMONWEALTH_CONFIG), "registry.json");
  }
  return path.join(os.homedir(), ".commonwealth", "registry.json");
}

async function loadRegistryMappings(registryPath) {
  const raw = await readFileOrNull(registryPath);
  if (raw === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const mappings =
    parsed && typeof parsed === "object" && Array.isArray(parsed.mappings) ? parsed.mappings : [];
  return mappings.filter(
    (m) =>
      m && typeof m === "object" && typeof m.prefix === "string" && typeof m.brain === "string",
  );
}

/**
 * Resolve the brain for `startDir`: (1) nearest `.commonwealth/brain` marker whose target
 * exists (a dangling marker is skipped so it falls through, #68) → (2) nearest ancestor that
 * is itself a brain (`.commonwealth/config.json`) → (3) user registry prefix mapping →
 * (4) `$COMMONWEALTH_BRAIN_DIR` → (5) null. Pure fs/path; never throws. Exported for tests so
 * the real resolution path is covered (not just injected fakes).
 */
export async function realResolveBrainDir(startDir) {
  if (typeof startDir !== "string" || startDir.length === 0) return null;
  const start = path.resolve(startDir);

  for (const dir of walkUp(start)) {
    const raw = await readFileOrNull(path.join(dir, MARKER_REL));
    if (raw !== null) {
      const target = raw.trim();
      if (target.length > 0) {
        const resolved = expandPath(target, dir);
        // Skip a dangling marker (missing target) so a stale one falls through to the
        // registry instead of hijacking capture to a dead brain path (#68).
        if (await isDir(resolved)) return resolved;
      }
    }
  }
  for (const dir of walkUp(start)) {
    if (await isFile(path.join(dir, BRAIN_CONFIG_REL))) return dir;
  }
  const mappings = await loadRegistryMappings(resolveRegistryPath());
  if (mappings) {
    for (const m of mappings) {
      if (isUnder(start, expandPath(m.prefix))) return expandPath(m.brain);
    }
  }
  const env = process.env.COMMONWEALTH_BRAIN_DIR;
  if (env && env.length > 0) return path.resolve(env);
  return null;
}

/**
 * Parse a `claude -p` reply into a candidate array. Tolerates surrounding prose or a
 * ```json code fence by extracting the first top-level `[ ... ]`. Returns [] on any failure.
 * Exported for unit testing.
 */
export function parseCandidateArray(text) {
  if (typeof text !== "string") return [];
  const trimmed = text.trim();
  let jsonText = trimmed;
  if (!trimmed.startsWith("[")) {
    const start = trimmed.indexOf("[");
    const end = trimmed.lastIndexOf("]");
    if (start === -1 || end === -1 || end < start) return [];
    jsonText = trimmed.slice(start, end + 1);
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  // Keep only well-formed candidates.
  return parsed.filter(
    (c) =>
      c &&
      typeof c === "object" &&
      typeof c.kind === "string" &&
      typeof c.title === "string" &&
      typeof c.body === "string",
  );
}
