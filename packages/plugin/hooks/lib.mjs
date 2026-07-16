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
//   resolveBrain(cwd)                  -> { kind, brain? }  (ADR-0024 §3: the ONE pass that is both
//                                                            routing AND scope — `brain` in scope +
//                                                            routed, `denied` out of scope, `none`
//                                                            nothing here. Retires the old split of
//                                                            resolveBrainDir + isInScope.)
//   getContext(brain, cwd)             -> string           (session-wide markdown; "" for none)
//   getContextQuery(brain, cwd, query) -> string           (prompt-scoped markdown; "" for no match)
//   extractCandidates({ transcriptPath, cwd })
//                                      -> { ok: true, candidates: NewNoteInput[] }
//                                       | { ok: false, host, error, ... }
//   classifyCandidates(brain, cwd, candidates)
//                                      -> NewNoteInput[] (each maybe + `verdict`; ADR-0030 LLM
//                                                         curation. Fail-open: returns candidates
//                                                         UNCHANGED on flag-off/no-runtime/error.)
//   capture(brain, cwd, candidates)    -> { captured, ... }(stage candidates via the review queue)
//   refreshStatus(brain, cwd)          -> void             (refresh the statusline cache; #197)
//   readCaptureMark(key)               -> number | null    (last prompt-capture ts for a session)
//   writeCaptureMark(key, ts)          -> void             (record a prompt-capture ts; #194)

import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClassifier } from "./classify.mjs";
import { compactClaudeTranscript, createExtractor, parseExtractionOutput } from "./extraction.mjs";

/**
 * Hard cap on the extraction `claude -p` child (#104). Extraction is an LLM call, so allow real
 * latency — but never let a hung/wedged child block SessionEnd forever; kill it past this.
 */
const EXTRACTION_TIMEOUT_MS = 120_000;

/**
 * Hard cap on the per-turn `context --query` child (#194). UserPromptSubmit runs synchronously on
 * the user's turn (Claude Code kills the whole hook at 30s), so a slow query must never hang it —
 * bound it well under that and inject nothing on timeout.
 */
const CONTEXT_QUERY_TIMEOUT_MS = 10_000;

/**
 * Default throttle between prompt-triggered captures (#194): capture during a long session at most
 * this often, so knowledge that scrolls out of context isn't lost if the session is abandoned
 * before PreCompact/SessionEnd — without paying a full LLM extraction on EVERY turn. Tunable via
 * `$COMMONWEALTH_PROMPT_CAPTURE_MS` (`0` disables prompt-capture entirely).
 */
const DEFAULT_PROMPT_CAPTURE_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Hard cap on the SessionStart sync (ADR-0032). SessionStart runs synchronously on the critical
 * path to context injection, so the pull must be short: on timeout we inject slightly-stale context
 * (fail-open) and finish the sync detached in the background. Kept well under Claude Code's hook
 * budget so a slow/offline remote never delays the session start noticeably.
 */
const SESSION_START_SYNC_TIMEOUT_MS = 5_000;

/**
 * Hard cap on the SessionEnd sync (ADR-0032). This runs inside the ALREADY-detached capture worker
 * (never on the user's critical path), so it can afford the full commit → pull --rebase → push
 * round-trip — but is still bounded so a wedged git op can't keep the worker alive forever. On
 * failure the receipt says the sync was deferred; the next SessionStart flushes the debt.
 */
const SESSION_END_SYNC_TIMEOUT_MS = 60_000;

/**
 * Env var the extraction spawn sets so the NESTED `claude -p` it launches doesn't re-fire the
 * Commonwealth SessionStart/SessionEnd hooks — which would recurse (each extraction spawning
 * another) and re-capture the extractor's own transcript (#104). The hook entries early-return
 * when this is set.
 */
export const DISABLE_HOOKS_ENV = "COMMONWEALTH_DISABLE_HOOKS";

/**
 * Ordered, deduped list of directories to try as the session's working directory. The
 * hook-supplied cwd comes first (it's the harness's answer and normally correct), then
 * `$CLAUDE_PROJECT_DIR`, then `process.cwd()`.
 *
 * Some launchers hand the hook a synthetic cwd that maps to no brain — e.g. Orca's rate-limit
 * PTY runs the session from `~/Library/Application Support/orca/rate-limit-pty-cwd`, which isn't
 * in anyone's registry. Without the fallbacks, every `/clear` in that state skips capture with
 * "no-brain" even though the real project maps to a brain. `$CLAUDE_PROJECT_DIR` is the canonical
 * project root Claude Code exports to hooks and is unaffected by such PTY cwd substitution, so it
 * recovers the real directory (#174).
 *
 * @param {string} inputCwd  The hook-supplied cwd (already validated as a non-empty string).
 * @returns {string[]}       Candidate directories to resolve a brain from, in priority order.
 */
function candidateCwds(inputCwd) {
  const out = [];
  const add = (c) => {
    if (typeof c === "string" && c.length > 0 && !out.includes(c)) out.push(c);
  };
  add(inputCwd);
  add(process.env.CLAUDE_PROJECT_DIR);
  try {
    add(process.cwd());
  } catch {
    // process.cwd() throws if the working directory was removed mid-session; just skip it.
  }
  return out;
}

/**
 * Resolve the session's working directory in ONE pass that is both routing and scope (ADR-0024 §3),
 * trying each {@link candidateCwds} entry in order:
 *  - the first candidate that resolves to a `brain` wins (in scope + routed) → `{ kind: "brain", cwd, brain }`;
 *  - else, if any candidate's config file was present-but-unparseable (`corrupt-config`, #210), report
 *    that → `{ kind: "corrupt-config", cwd, path, error }` (so SessionEnd surfaces a "fix your config"
 *    receipt, not the misleading "no brain mapped — add it to your registry");
 *  - else, if any candidate was an explicit `denied` (a deny rule — the privacy gate), report that
 *    → `{ kind: "denied", cwd }` (so SessionEnd surfaces an out-of-scope receipt, not "no brain");
 *  - else nothing was configured for any candidate → `{ kind: "none" }`.
 *
 * A brain-mapped fallback still wins over an earlier denied/corrupt candidate (matching the
 * pre-ADR-0024 behavior where a denied cwd fell through to `$CLAUDE_PROJECT_DIR` / `process.cwd()`).
 *
 * @param {string} inputCwd  The hook-supplied cwd (already validated as a non-empty string).
 * @param {object} deps      See the contract at the top of this file.
 * @returns {Promise<{kind: "brain", cwd: string, brain: string} | {kind: "corrupt-config", cwd: string, path: string, error: string} | {kind: "denied", cwd: string} | {kind: "none"}>}
 */
async function resolveSessionBrain(inputCwd, deps) {
  let denied = null;
  let corrupt = null;
  for (const cwd of candidateCwds(inputCwd)) {
    const r = await deps.resolveBrain(cwd);
    if (r && r.kind === "brain" && typeof r.brain === "string" && r.brain.length > 0) {
      return { kind: "brain", cwd, brain: r.brain };
    }
    if (r && r.kind === "corrupt-config" && !corrupt) {
      corrupt = {
        kind: "corrupt-config",
        cwd,
        path: typeof r.path === "string" ? r.path : "",
        error: typeof r.error === "string" ? r.error : "",
      };
    }
    if (r && r.kind === "denied" && !denied) denied = { kind: "denied", cwd };
  }
  // A broken config is a loud, actionable failure — surface it ahead of a deny/none silence.
  return corrupt ?? denied ?? { kind: "none" };
}

/**
 * True when `cwd` is a synthetic launcher directory, not a real project — e.g. Orca's rate-limit
 * PTY runs sessions from `~/Library/Application Support/orca/rate-limit-pty-cwd`. Such a directory
 * never maps to a brain and the fallbacks in {@link candidateCwds} can't recover the real project
 * (the rate-limit PTY runs with `$CLAUDE_PROJECT_DIR` unset). So a "no brain mapped — add it to
 * your registry" receipt is not just noise but WRONG advice: the real project IS mapped; this PTY
 * simply isn't run from it. SessionEnd skips these silently instead of nagging every rate-limit
 * cycle (#180). Keyed off the `-pty-cwd` basename Orca uses for these synthetic working dirs.
 *
 * @param {string} cwd
 * @returns {boolean}
 */
function isSyntheticLauncherCwd(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) return false;
  const base = path.basename(cwd);
  return base.endsWith("-pty-cwd");
}

/**
 * SessionStart: resolve the brain for the session's cwd, honor the per-user scope gate,
 * and return the markdown context string to inject. Returns "" (inject nothing) when there
 * is no brain for this cwd or the cwd is out of scope — the two gates that make an
 * out-of-scope or brain-less session do NOTHING. When the hook-supplied cwd maps to no brain,
 * it falls back to `$CLAUDE_PROJECT_DIR` / `process.cwd()` (see {@link candidateCwds}); the
 * scope gate and context then use whichever candidate actually resolved.
 *
 * @param {{ cwd: string }} input  Parsed SessionStart hook stdin.
 * @param {object} deps            See the contract at the top of this file.
 * @returns {Promise<string>}      Context markdown to print to stdout, or "".
 */
export async function sessionStart(input, deps) {
  const inputCwd = input?.cwd;
  if (typeof inputCwd !== "string" || inputCwd.length === 0) return "";

  // One pass decides both scope and brain: only a routed `brain` (in scope) injects anything;
  // `denied` (out of scope) and `none` (nothing here) both inject nothing.
  const resolved = await resolveSessionBrain(inputCwd, deps);
  if (resolved.kind !== "brain") return "";

  // Daemonless lifecycle sync (ADR-0032): pull teammates' latest AND flush any debt left by a prior
  // failed/offline session-end, BEFORE injecting context — but time-capped hard so a slow remote
  // never stalls the session. If a sync daemon owns this brain, skip entirely (it already
  // converges continuously). On timeout/failure we fail OPEN — inject slightly-stale context — and
  // spawn the sync detached so it completes in the background (debt flush). Guarded on the dep so
  // older wiring / unit tests that don't inject a sync seam are unaffected.
  await lifecycleSync(deps, resolved.brain, {
    timeoutMs: SESSION_START_SYNC_TIMEOUT_MS,
    detachOnFailure: true,
  });

  const context = await deps.getContext(resolved.brain, resolved.cwd);
  return typeof context === "string" ? context : "";
}

/**
 * Run a lifecycle sync-once for `brain`, honoring daemon arbitration and returning a small outcome
 * (ADR-0032). Never throws — a hook must never break the session. Returns:
 *  - `{ ran: false, reason: "no-seam" }`  when no sync dep is wired (older wiring / unit tests);
 *  - `{ ran: false, reason: "daemon" }`   when a sync daemon owns this brain (it already converges);
 *  - `{ ran: true, ok }`                  when sync-once ran (ok=false on timeout/failure).
 *
 * When `detachOnFailure` is set and the capped sync did not succeed, a detached background sync is
 * spawned so the pull/flush still completes without blocking the caller (the SessionStart debt
 * flush). Callers decide what to do with a non-ok outcome (SessionStart fails open; SessionEnd
 * records a deferred-sync breadcrumb on the receipt).
 *
 * @param {object} deps
 * @param {string} brain
 * @param {{ timeoutMs: number, detachOnFailure?: boolean }} opts
 * @returns {Promise<{ ran: boolean, ok?: boolean, reason?: string }>}
 */
async function lifecycleSync(deps, brain, opts) {
  if (typeof deps.syncOnce !== "function") return { ran: false, reason: "no-seam" };
  try {
    if (typeof deps.isDaemonRunning === "function" && (await deps.isDaemonRunning(brain))) {
      return { ran: false, reason: "daemon" };
    }
    const res = await deps.syncOnce(brain, { timeoutMs: opts.timeoutMs });
    const ok = !!res && res.ok === true;
    if (!ok && opts.detachOnFailure && typeof deps.spawnDetachedSync === "function") {
      deps.spawnDetachedSync(brain);
    }
    return { ran: true, ok };
  } catch {
    // A sync failure must never break the session; treat it as a non-ok run.
    if (opts.detachOnFailure && typeof deps.spawnDetachedSync === "function") {
      try {
        deps.spawnDetachedSync(brain);
      } catch {
        // best-effort background flush
      }
    }
    return { ran: true, ok: false };
  }
}

/**
 * UserPromptSubmit (#194): fires on EVERY turn with the user's prompt, so we can inject the notes
 * relevant to what the developer is asking *right now* — the query-driven retrieval SessionStart
 * can't do (it has no prompt yet). Resolves the brain in the same single ADR-0024 §3 pass as
 * {@link sessionStart} (which IS the scope gate: `denied`/`none` → inject nothing), then runs the
 * query path and returns markdown to inject via `additionalContext`. Returns "" when: there's no
 * prompt, the cwd isn't in scope, or — the hard relevance gate — the query matched nothing (the
 * query `context` command prints nothing without a real match). Complements SessionStart's
 * session-wide context; does not replace it. Runs synchronously on the user's turn, so keep it
 * fast (see {@link realDeps}'s prefer-vendored-binary fast path) and time-bounded.
 *
 * @param {{ cwd: string, prompt?: string, user_prompt?: string }} input  Parsed UserPromptSubmit stdin.
 * @param {object} deps  See the contract at the top of this file.
 * @returns {Promise<string>}  Prompt-scoped context markdown, or "".
 */
export async function userPromptSubmit(input, deps) {
  const inputCwd = input?.cwd;
  if (typeof inputCwd !== "string" || inputCwd.length === 0) return "";

  // Claude Code names the field `prompt`; tolerate `user_prompt` too. No prompt → nothing to query.
  const rawPrompt =
    typeof input?.prompt === "string"
      ? input.prompt
      : typeof input?.user_prompt === "string"
        ? input.user_prompt
        : "";
  const query = rawPrompt.trim();
  if (query.length === 0) return "";

  const resolved = await resolveSessionBrain(inputCwd, deps);
  if (resolved.kind !== "brain") return "";

  // The query path is the hard relevance gate: it renders context only when notes actually match,
  // so an off-topic prompt injects nothing (no per-turn noise).
  const context = await deps.getContextQuery(resolved.brain, resolved.cwd, query);
  return typeof context === "string" ? context : "";
}

/**
 * Parse the prompt-capture throttle interval from the environment (#194). Empty/unset → the default;
 * a non-negative integer of milliseconds; `0` (or negative) disables prompt-triggered capture. Pure.
 */
export function promptCaptureIntervalMs(env = process.env) {
  const raw = env.COMMONWEALTH_PROMPT_CAPTURE_MS;
  if (raw === undefined || raw === "") return DEFAULT_PROMPT_CAPTURE_INTERVAL_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : DEFAULT_PROMPT_CAPTURE_INTERVAL_MS;
}

/**
 * Decide whether a prompt-triggered capture should fire now (#194) — the "if needed" throttle so we
 * don't run a full LLM extraction on every turn. Fires when capture is enabled (`intervalMs > 0`)
 * and either this session has never captured (`lastMark` null) or at least `intervalMs` has elapsed
 * since it last did. Pure — the entry supplies `now`/`lastMark` and does the launch.
 *
 * @param {{ lastMark: number | null, now: number, intervalMs: number }} args
 * @returns {boolean}
 */
export function shouldCaptureNow({ lastMark, now, intervalMs }) {
  if (typeof intervalMs !== "number" || intervalMs <= 0) return false; // disabled
  if (typeof lastMark !== "number") return true; // never captured this session
  return now - lastMark >= intervalMs;
}

/**
 * SessionEnd: resolve the brain, honor the scope gate, extract candidate notes from the
 * session transcript, and stage them via the review queue (capture). Out-of-scope or
 * brain-less sessions do NOTHING (they never extract candidates or capture). A session with
 * no candidates reports `{ captured: 0 }`. When the hook-supplied cwd maps to no brain, it
 * falls back to `$CLAUDE_PROJECT_DIR` / `process.cwd()` (see {@link candidateCwds}); scope,
 * capture, and the receipt then use whichever candidate actually resolved.
 *
 * @param {{ cwd: string, transcript_path?: string, commonwealth_capture_boundary?: "turn" | "compaction" }} input  Parsed capture hook stdin.
 * @param {object} deps                                       See the contract above.
 * @returns {Promise<object>}  A small result object for the hook to log to stderr.
 */
export async function sessionEnd(input, deps) {
  const inputCwd = input?.cwd;
  const boundary = input?.commonwealth_capture_boundary;
  // No cwd: nothing to say and nowhere to anchor a receipt — skip silently.
  if (typeof inputCwd !== "string" || inputCwd.length === 0)
    return { skipped: true, reason: "no-cwd" };

  const resolved = await resolveSessionBrain(inputCwd, deps);
  if (resolved.kind === "corrupt-config") {
    // The per-user config file exists but doesn't parse (#210). No brain resolved, so nothing was
    // captured — but that's a BROKEN config, not "no brain here". Anchor a loud, actionable receipt
    // to the cwd so the next SessionStart there tells the user to fix the file (never silent).
    return await finishEnd(
      deps,
      resolved.cwd,
      {
        skipped: true,
        reason: "corrupt-config",
        path: resolved.path,
        error: resolved.error,
      },
      boundary,
    );
  }
  if (resolved.kind === "denied") {
    // An explicit deny rule matched (the privacy gate) — out of scope. Anchor the receipt to the
    // denied cwd so the next SessionStart there explains the silence.
    return await finishEnd(deps, resolved.cwd, { skipped: true, reason: "out-of-scope" }, boundary);
  }
  if (resolved.kind !== "brain") {
    // A synthetic launcher cwd (e.g. Orca's rate-limit PTY) never maps to a brain and isn't a
    // real work session. Skip SILENTLY — a "map it in your registry" receipt would be wrong
    // advice and would re-nag every rate-limit cycle (#180). No receipt, so nothing is surfaced.
    if (isSyntheticLauncherCwd(inputCwd)) return { skipped: true, reason: "synthetic-cwd" };
    // No brain for the hook cwd or any fallback. Anchor the receipt to the hook cwd so the next
    // SessionStart there can explain the silence.
    return await finishEnd(deps, inputCwd, { skipped: true, reason: "no-brain" }, boundary);
  }
  const { cwd, brain } = resolved;

  const extracted = await deps.extractCandidates({
    transcriptPath: input.transcript_path,
    cwd,
  });
  // Extraction failures are operational failures, not a legitimate zero-candidate result. Stop
  // before curate so a missing/auth-failed/timed-out host CLI can never be reported as "nothing
  // worth capturing" (or accidentally invoke capture with an invalid payload).
  if (!extracted || extracted.ok !== true || !Array.isArray(extracted.candidates)) {
    return await finishEnd(
      deps,
      cwd,
      {
        captured: 0,
        failed: true,
        reason: "extractor-failure",
        host: extracted?.host,
        runtime: extracted?.runtime,
        code: extracted?.code,
        signal: extracted?.signal,
        timedOut: extracted?.timedOut === true || extracted?.reason === "extractor-timeout",
        error:
          typeof extracted?.error === "string"
            ? extracted.error
            : extracted?.error
              ? String(extracted.error)
              : "extractor returned an invalid result",
      },
      boundary,
    );
  }
  let candidates = extracted.candidates;
  // LLM curation pass (ADR-0030): annotate each candidate with a durability/consolidation verdict
  // BEFORE curate applies it. This is fail-open by construction — `classifyCandidates` returns the
  // candidates unchanged when the `llmCurator` flag is off, no host runtime is available, or the
  // classifier times out / errors — so capture behavior degrades to today's DISTINCT path, never
  // dropping a candidate. Absent dep (older wiring / unit tests) → skip entirely.
  if (
    Array.isArray(candidates) &&
    candidates.length > 0 &&
    typeof deps.classifyCandidates === "function"
  ) {
    const annotated = await deps.classifyCandidates(brain, cwd, candidates);
    if (Array.isArray(annotated)) candidates = annotated;
  }
  let result =
    Array.isArray(candidates) && candidates.length > 0
      ? await deps.capture(brain, cwd, candidates)
      : { captured: 0 };

  // Daemonless lifecycle sync (ADR-0032): commit → pull --rebase → push the notes this session just
  // staged/promoted, right here in the already-detached worker. Only when at least one note landed —
  // a zero-capture session has nothing to sync, so we never make a pointless empty commit/push. If a
  // sync daemon owns this brain, skip (it converges continuously). On timeout/failure we DON'T throw:
  // the notes are safely committed locally (or will be by the next commit) and the next SessionStart
  // flushes the debt — the receipt just says so, so the deferral is never silent.
  const capturedCount = typeof result?.captured === "number" ? result.captured : 0;
  if (capturedCount >= 1) {
    const outcome = await lifecycleSync(deps, brain, { timeoutMs: SESSION_END_SYNC_TIMEOUT_MS });
    if (outcome.ran && outcome.ok !== true) {
      result = { ...result, syncDeferred: true };
      console.error("[commonwealth] sync deferred — will flush next session.");
    }
  }

  // Refresh the ambient status cache AFTER capture so the statusline reflects this session's notes
  // (#197). We're in the detached worker here, off the per-turn statusline hot path, so the index
  // work is free to run. Best-effort — the dep swallows its own errors; a hook must never break.
  if (typeof deps.refreshStatus === "function") await deps.refreshStatus(brain, cwd);

  return await finishEnd(deps, cwd, result, boundary);
}

/**
 * Persist a one-line receipt describing what this SessionEnd did, so the NEXT SessionStart in
 * the same directory can surface it (#96). SessionEnd's own stdout/systemMessage is invisible —
 * especially after `/clear`, which wipes the transcript — so a visible "here's why nothing was
 * captured" must be deferred to the next start. Best-effort via `deps.saveReceipt`; returns the
 * result unchanged so the hook's stderr summary is untouched.
 */
async function finishEnd(deps, cwd, result, boundary) {
  const message = endReceiptMessage(result, boundary);
  if (message && typeof deps.saveReceipt === "function") {
    await deps.saveReceipt({ cwd, message, ts: Date.now() });
  }
  return result;
}

/** Select the extraction host carried by a capture-worker payload; legacy hooks default Claude. */
export function captureWorkerHost(input) {
  return typeof input?.commonwealth_host === "string" && input.commonwealth_host.length > 0
    ? input.commonwealth_host
    : "claude";
}

/**
 * Launch the SessionEnd capture as a DETACHED background worker and return at once.
 *
 * SessionEnd is fire-and-forget: Claude Code does not wait for it and, on `/clear`, tears the old
 * session down immediately and starts the next one. Capture does an LLM extraction (tens of
 * seconds), so running it inline as an ordinary child of the hook process means that child is
 * killed mid-flight on `/clear` — before it can extract, capture, or write the receipt. That is
 * why every `/clear` silently captured nothing while the identical hook run standalone (nothing to
 * kill it) worked (#190). Detaching fixes it: `detached: true` puts the worker in its OWN process
 * group/session (setsid), so the teardown signals sent to the old session's group never reach it;
 * `stdio: "ignore"` + `unref()` let the hook process exit immediately without waiting. The worker
 * then finishes in the background — notes land seconds after `/clear`, and the next SessionStart in
 * the directory surfaces the receipt as designed (#96).
 *
 * The hook JSON is passed as a single argv element (it is tiny — cwd/transcript_path/reason, never
 * the transcript itself), because a detached child with `stdio: "ignore"` has no stdin to read.
 *
 * @param {string|object} rawInput  The hook stdin (raw string or parsed object) to hand the worker.
 * @param {{ workerPath: string, nodeBin?: string, spawnFn?: Function }} opts
 * @returns {Promise<object|null>}  The spawned child (unref'd), or null if it could not launch.
 */
export async function launchCaptureWorker(rawInput, opts = {}) {
  const workerPath = opts.workerPath;
  if (typeof workerPath !== "string" || workerPath.length === 0) return null;
  const nodeBin = opts.nodeBin ?? process.execPath;
  const spawnFn = opts.spawnFn ?? (await import("node:child_process")).spawn;
  const payload = typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput ?? {});
  let child;
  try {
    child = spawnFn(nodeBin, [workerPath, payload], { detached: true, stdio: "ignore" });
  } catch {
    // A hook must never break the session: if the worker can't be spawned, capture is skipped
    // (this session's knowledge is lost) but the session start/end proceeds unharmed.
    return null;
  }
  // Don't keep the hook process alive waiting on the worker — it must return at once so the
  // harness isn't blocked, while the worker (its own process group) runs to completion.
  if (child && typeof child.unref === "function") child.unref();
  return child;
}

/**
 * Parse the `capture` CLI's stdout into structured notes (#204). Each line is either a staged
 * note `<id>  [<kind>]  <title>` or an auto-promoted one `promoted  <path>  [<kind>]  <title>`
 * (see curate/src/index.ts). We key off the first `[kind]` bracket (ids/paths never contain
 * brackets) and take everything after it as the title, so titles with spaces survive intact.
 * Unparseable lines are skipped. Pure function.
 *
 * @param {string} stdout  Raw stdout from the `capture` command.
 * @returns {Array<{kind: string, title: string, promoted: boolean}>}
 */
export function parseCaptureLines(stdout) {
  if (typeof stdout !== "string") return [];
  const notes = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const m = line.match(/\[([^\]]+)\]\s+(.+)$/);
    if (!m) continue;
    notes.push({ kind: m[1], title: m[2].trim(), promoted: line.startsWith("promoted") });
  }
  return notes;
}

/** Prefix of the machine-readable verdict-summary line `capture` emits (ADR-0030). Keep in sync
 *  with `VERDICT_SUMMARY_PREFIX` in packages/curate/src/index.ts. */
const VERDICT_SUMMARY_PREFIX = "##commonwealth:verdicts ";

/**
 * Parse the LLM curation verdict summary (ADR-0030) `capture` appends to its stdout, or `null` when
 * absent (no curator ran / it changed nothing). The summary counts what the curation pass did:
 * notes that superseded canon, notes flagged as contradictions, candidates filtered as trivia, and
 * candidates rejected as duplicates. Pure function; last summary line wins. Never throws.
 *
 * @param {string} stdout  Raw stdout from the `capture` command.
 * @returns {{superseded: number, contradicted: number, trivia: number, duplicate: number} | null}
 */
export function parseVerdictSummary(stdout) {
  if (typeof stdout !== "string") return null;
  let found = null;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith(VERDICT_SUMMARY_PREFIX)) continue;
    try {
      const parsed = JSON.parse(line.slice(VERDICT_SUMMARY_PREFIX.length));
      if (parsed && typeof parsed === "object") {
        found = {
          superseded: Number(parsed.superseded) || 0,
          contradicted: Number(parsed.contradicted) || 0,
          trivia: Number(parsed.trivia) || 0,
          duplicate: Number(parsed.duplicate) || 0,
          clamped: Number(parsed.clamped) || 0,
        };
      }
    } catch {
      // Ignore a malformed summary line — the note lines still render the receipt.
    }
  }
  return found;
}

/**
 * Render the parenthetical curation clause for a capture receipt (ADR-0030), e.g.
 * " (1 superseded an older note, 1 flagged as a contradiction, 2 filtered as trivia)", or "" when
 * the pass changed nothing / didn't run. Pure function.
 */
function verdictClause(verdicts) {
  if (!verdicts || typeof verdicts !== "object") return "";
  const parts = [];
  if (verdicts.superseded > 0) parts.push(`${verdicts.superseded} superseded an older note`);
  if (verdicts.contradicted > 0)
    parts.push(
      `${verdicts.contradicted} flagged as a contradiction${verdicts.contradicted === 1 ? "" : "s"}`,
    );
  if (verdicts.trivia > 0) parts.push(`${verdicts.trivia} filtered as trivia`);
  if (verdicts.duplicate > 0) parts.push(`${verdicts.duplicate} dropped as duplicate(s)`);
  // Surface a clamped verdict so a misbehaving/injected classifier is visible, not silent.
  if (verdicts.clamped > 0)
    parts.push(`${verdicts.clamped} verdict(s) clamped to distinct (unsafe target)`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/** Cap on how many note titles a capture receipt lists inline before collapsing to "(+N more)". */
const RECEIPT_TITLE_LIMIT = 3;

/**
 * Render a capture receipt that shows WHAT was remembered, not just a count (#204). Lists up to
 * {@link RECEIPT_TITLE_LIMIT} titles then "(+N more)", so it stays a glanceable diff rather than a
 * wall of text. Tense is keyed on `autoPromote` (ADR-0014) via each note's `promoted` flag:
 * promoted notes are already canon → a past-tense "remembered" notification; staged notes await
 * review → a "staged … run /commonwealth:promote" nudge. Pure function.
 *
 * @param {Array<{kind: string, title: string, promoted: boolean}>} notes
 * @returns {string}
 */
function renderCaptureReceipt(notes, boundary, verdicts) {
  const source = captureBoundaryLabel(boundary);
  const shown = notes.slice(0, RECEIPT_TITLE_LIMIT).map((n) => `• "${n.title}"`);
  const extra = notes.length - shown.length;
  const list = [...shown, ...(extra > 0 ? [`(+${extra} more)`] : [])].join("\n");
  // The LLM curation pass (ADR-0030) appends what it did — superseded / contradiction / trivia.
  const clause = verdictClause(verdicts);
  // autoPromote is a brain-level flag, so a capture is all-promoted or all-staged; `some` is a
  // belt-and-suspenders read in case a line ever fails to parse its prefix.
  const promoted = notes.some((n) => n.promoted);
  if (promoted) {
    return `🧠 Commonwealth remembered from ${source}${clause}:\n${list}\nRun \`commonwealth status\` to review.`;
  }
  return `🧠 Commonwealth staged ${notes.length} note(s) from ${source} for review${clause}:\n${list}\nRun \`/commonwealth:promote\` to approve.`;
}

/** Describe which transcript boundary a capture worker reviewed. */
function captureBoundaryLabel(boundary) {
  if (boundary === "turn") return "the Codex transcript at the latest turn boundary";
  if (boundary === "compaction") return "the pre-compaction history";
  return "the last session";
}

/**
 * Human-readable receipt for a {@link sessionEnd} outcome, or `null` when there is nothing worth
 * telling the user. Turns the silent no-op (#96) into a specific explanation: a skip says WHY (no
 * brain / out of scope), a zero-capture says the extractor found nothing, and a real capture lists
 * WHAT was remembered (#204) — falling back to a bare count when structured notes are unavailable.
 * Pure function.
 *
 * @param {{skipped?: boolean, failed?: boolean, reason?: string, path?: string, error?: string, runtime?: string, host?: string, code?: number | null, signal?: string | null, timedOut?: boolean, captured?: number, notes?: Array<{kind: string, title: string, promoted: boolean}>}} result
 * @param {"turn" | "compaction" | undefined} boundary
 * @returns {string | null}
 */
export function endReceiptMessage(result, boundary) {
  if (!result || typeof result !== "object") return null;
  const source = captureBoundaryLabel(boundary);
  if (result.failed && result.reason === "extractor-failure") {
    const host = typeof result.host === "string" && result.host.length > 0 ? ` ${result.host}` : "";
    const runtime =
      typeof result.runtime === "string" && result.runtime.length > 0 ? ` (${result.runtime})` : "";
    const outcome = result.timedOut
      ? " timed out"
      : typeof result.code === "number"
        ? ` exited ${result.code}`
        : typeof result.signal === "string" && result.signal.length > 0
          ? ` was killed by ${result.signal}`
          : " failed to start or returned invalid output";
    const rawDetail =
      typeof result.error === "string" && result.error.length > 0 ? result.error : "";
    const detail = rawDetail ? `: ${rawDetail}${/[.!?]$/.test(rawDetail) ? "" : "."}` : ".";
    return `🧠 Commonwealth: capture FAILED because the${host} extractor${runtime}${outcome}${detail} Knowledge extraction did NOT complete and curate was NOT run. Run \`commonwealth doctor\` to diagnose the host runtime.`;
  }
  if (result.failed && result.reason === "curate-runtime") {
    const runtime =
      typeof result.runtime === "string" && result.runtime.length > 0 ? ` (${result.runtime})` : "";
    const exit = typeof result.code === "number" ? ` exited ${result.code}` : " failed to start";
    const rawDetail =
      typeof result.error === "string" && result.error.length > 0 ? result.error : "";
    const detail = rawDetail ? `: ${rawDetail}${/[.!?]$/.test(rawDetail) ? "" : "."}` : ".";
    return `🧠 Commonwealth: capture FAILED because the curate runtime${runtime}${exit}${detail} Extracted knowledge was NOT saved. Run \`commonwealth doctor\` to diagnose the live runtime path.`;
  }
  if (result.skipped) {
    if (result.reason === "corrupt-config") {
      // A broken config file (#210): a hand-edit typo makes every reader treat the brain as missing
      // and silently disables ALL capture. Name the file and the parse error and say how to fix it —
      // never let a one-char typo turn the flagship feature off invisibly.
      const where =
        typeof result.path === "string" && result.path.length > 0 ? ` (${result.path})` : "";
      const why =
        typeof result.error === "string" && result.error.length > 0 ? ` — ${result.error}` : "";
      return `🧠 Commonwealth: your config file${where} is unparseable${why}, so NO brain resolved and nothing was captured. Fix the JSON (a stray trailing comma is the usual cause) or restore it from a \`.corrupt-<ts>\` backup, then run \`commonwealth doctor\` to confirm.`;
    }
    if (result.reason === "no-brain") {
      return `🧠 Commonwealth: ${source} was in a directory with no team brain mapped, so nothing was captured. Add a rule with \`commonwealth registry\` (or run \`commonwealth add\`) to capture here.`;
    }
    if (result.reason === "out-of-scope") {
      return `🧠 Commonwealth: ${source}'s directory is outside your Commonwealth capture scope, so nothing was captured.`;
    }
    return null; // no-cwd / unknown — nothing useful to surface
  }
  // A sync-deferred capture (ADR-0032): the notes are safely committed locally but the push/pull
  // didn't complete this session (offline / slow / killed). Append a breadcrumb so the deferral is
  // visible, never silent — the next SessionStart flushes the debt.
  const syncNote = result.syncDeferred
    ? "\n⏳ Sync deferred — notes are saved locally and will flush to your team at the next session."
    : "";
  // Prefer the legible, titled receipt when we have structured notes (#204), naming what the LLM
  // curation pass did (ADR-0030) via the verdict summary the capture command reported.
  if (Array.isArray(result.notes) && result.notes.length > 0) {
    return renderCaptureReceipt(result.notes, boundary, result.verdicts) + syncNote;
  }
  if (typeof result.captured === "number") {
    if (result.captured === 0) {
      // The curation pass can legitimately filter every candidate as trivia/duplicate — say so,
      // rather than the misleading "found no durable knowledge" (nothing was extracted).
      const clause = verdictClause(result.verdicts);
      if (clause) {
        return `🧠 Commonwealth: reviewed ${source} and captured nothing${clause}.`;
      }
      return `🧠 Commonwealth: reviewed ${source} but found no durable knowledge worth capturing.`;
    }
    const n = result.captured;
    return `🧠 Commonwealth: captured ${n} note(s) from ${source}. Run \`commonwealth status\` to review.${syncNote}`;
  }
  return null;
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

/**
 * Build the UserPromptSubmit hook's stdout payload (#194). Returns `null` when there is no context
 * to inject (empty/whitespace) so the hook writes nothing. Otherwise returns the JSON shape Claude
 * Code expects for this event: `additionalContext` is injected into the model for THIS turn (fresh
 * each turn). No `systemMessage` — per-turn retrieval is silent, not a user-facing receipt. Pure.
 *
 * @param {string} context  The prompt-scoped context from {@link userPromptSubmit}.
 * @returns {{ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: string } } | null}
 */
export function buildUserPromptSubmitOutput(context) {
  if (typeof context !== "string" || context.trim().length === 0) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context,
    },
  };
}

/**
 * Fold a deferred SessionEnd receipt (#96) into the SessionStart output. The receipt is
 * user-facing only, so it goes in `systemMessage` — never in `additionalContext` (it must not
 * pollute the model's injected context). Cases:
 *  - no output + no receipt → `null` (write nothing);
 *  - no output + a receipt → `{ systemMessage }` alone (a skip/zero-capture still speaks up);
 *  - output + a receipt → the receipt is appended to the existing `systemMessage`.
 * Pure function.
 *
 * @param {object | null} output          Result of {@link buildSessionStartOutput}.
 * @param {string | null} receiptMessage  Message from the prior session's {@link endReceiptMessage}.
 * @returns {object | null}
 */
export function attachReceipt(output, receiptMessage) {
  const msg =
    typeof receiptMessage === "string" && receiptMessage.trim().length > 0 ? receiptMessage : null;
  if (!output) return msg ? { systemMessage: msg } : null;
  if (!msg) return output;
  const prior =
    typeof output.systemMessage === "string" && output.systemMessage.length > 0
      ? `${output.systemMessage}\n${msg}`
      : msg;
  return { ...output, systemMessage: prior };
}

// ---------------------------------------------------------------------------------------
// Production dependencies. These are only imported/used at runtime by the real hooks, never
// by the unit tests (which inject fakes), so importing this module is cheap and side-effect
// free until `realDeps()` is called.
// ---------------------------------------------------------------------------------------

/**
 * Reduce a Claude Code transcript (JSONL) to the conversational signal the capture agent
 * needs — user/assistant text and tool *names* — dropping the bulky `tool_result` payloads
 * (file reads, command output) that dominate size. This preserves the WHOLE session (early
 * decisions included), unlike a byte-tail cap. Falls back to the raw transcript if the lines
 * don't parse as the expected shape, so a schema change never makes capture worse. (#84)
 */
export function compactTranscript(raw) {
  // Preserve the legacy helper's sentinel: callers used an empty string to decide when to fall
  // back to the raw transcript. The host extractor owns that fallback internally now.
  if (
    typeof raw === "string" &&
    raw.length > 0 &&
    !raw.split("\n").some((line) => {
      try {
        JSON.parse(line.trim());
        return true;
      } catch {
        return false;
      }
    })
  ) {
    return "";
  }
  return compactClaudeTranscript(raw);
}

/**
 * Run a command, resolving with `{ code, signal, timedOut, stdout, stderr, error? }`. Never
 * rejects — a missing
 * binary or non-zero exit is reported via `code` (or `code: null` + `error`). `input`, if
 * given, is written to the child's stdin. `timeoutMs`, if given, hard-kills the child (SIGKILL)
 * after that long so a wedged child can't block the hook forever (#104). Lazy-imports
 * `node:child_process` so importing this module stays side-effect free for tests.
 */
async function run(cmd, args, { input, cwd, env, timeoutMs } = {}) {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve) => {
    let child;
    let settled = false;
    let timedOut = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) globalThis.clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawn(cmd, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      finish({
        code: null,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: String(error),
        error,
      });
      return;
    }
    if (typeof timeoutMs === "number" && timeoutMs >= 0) {
      timer = globalThis.setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      timer.unref?.();
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
      finish({
        code: null,
        signal: null,
        timedOut,
        stdout,
        stderr: stderr + String(error),
        error,
      });
    });
    child.on("close", (code, signal) => {
      finish({ code, signal, timedOut, stdout, stderr });
    });
    if (typeof input === "string") {
      // Ignore EPIPE etc. if the child exits before consuming stdin — an unhandled stream
      // 'error' would crash the hook process and break the session (#84 hardening).
      child.stdin.on("error", () => {});
      child.stdin.write(input, () => child.stdin.end());
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Build the production `deps` for the hooks.
 *
 * - `resolveBrain` mirrors `@cmnwlth/core`'s unified resolver (ADR-0024): one pass that is both
 *   routing AND scope — `brain` (in scope), `denied` (out of scope), or `none`. This retires the
 *   old split of `resolveBrainDir` + a separate `scope check` shell-out (one fewer npx per session).
 * - `getContext` / `getContextQuery` / `capture` run `commonwealth-curate` with
 *   `COMMONWEALTH_BRAIN_DIR` set — reusing curate's relevance selection, dedupe, and gates.
 * - `extractCandidates` delegates to the selected host extractor (`claude` or `codex`) and keeps
 *   operational failures distinct from a valid zero-candidate result.
 *
 * @param {object} [overrides]  Optional overrides (curateEntry/curatePackage/nodeBin/claudeBin) for tests.
 * @returns {object}            The `deps` object matching the contract at the top.
 */
/**
 * The plugin's vendored curate entry (`<pluginRoot>/vendor/curate/index.js`), or null when absent.
 * When present it is the fast path for {@link realDeps} — a direct `node <entry>` with no `npx -y`
 * registry resolution — which is what makes the per-turn UserPromptSubmit hook viable (#194).
 */
function resolveVendoredCurate() {
  try {
    const entry = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "vendor",
      "curate",
      "index.js",
    );
    return existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the exact curate command the production hooks will run. Exported so `commonwealth
 * doctor` can import the installed hook and probe the SAME decision rather than maintaining a
 * second, drift-prone approximation (#222).
 *
 * @param {object} [overrides]
 * @returns {{kind: "entry" | "vendored" | "npx", command: string, args: string[], display: string}}
 */
export function resolveCurateRuntime(overrides = {}) {
  const nodeBin = overrides.nodeBin ?? process.execPath;
  const hasExplicitEntry = Object.prototype.hasOwnProperty.call(overrides, "curateEntry");
  const explicitEntry = overrides.curateEntry;
  // An explicit null disables vendor resolution in tests that exercise the npx fallback.
  const vendoredEntry = hasExplicitEntry ? explicitEntry : resolveVendoredCurate();
  if (vendoredEntry) {
    const kind = hasExplicitEntry ? "entry" : "vendored";
    return {
      kind,
      command: nodeBin,
      args: [vendoredEntry],
      display: `${nodeBin} ${vendoredEntry}`,
    };
  }

  const curatePackage = overrides.curatePackage ?? "@cmnwlth/curate@0.1.11";
  const npxBin = overrides.npxBin ?? "npx";
  return {
    kind: "npx",
    command: npxBin,
    args: ["-y", curatePackage],
    display: `${npxBin} -y ${curatePackage}`,
  };
}

/**
 * The plugin's vendored sync entry (`<pluginRoot>/vendor/sync/index.js`), or null when absent. Same
 * fast path as {@link resolveVendoredCurate}: a direct `node <entry> sync --dir <brain>` with no
 * `npx -y` registry resolution. A bare git-clone install has no `vendor/`, so we fall back to npx.
 */
function resolveVendoredSync() {
  try {
    const entry = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "vendor",
      "sync",
      "index.js",
    );
    return existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the sync-once command the daemonless lifecycle hooks run (ADR-0032), mirroring
 * {@link resolveCurateRuntime}'s vendored → npx discipline (ADR-0026). The returned `args` are the
 * BASE invocation (the entry / package); callers append the subcommand + `--dir <brain>`. Reusing
 * the sync package's `sync` subcommand drives the SAME engine as the daemon (commit → pull --rebase
 * → push, secret scrub, cross-process lock, bounded retry) — the plugin never forks git logic.
 *
 * @param {object} [overrides]  syncEntry / syncPackage / nodeBin / npxBin (tests).
 * @returns {{kind: "entry" | "vendored" | "npx", command: string, args: string[], display: string}}
 */
export function resolveSyncRuntime(overrides = {}) {
  const nodeBin = overrides.nodeBin ?? process.execPath;
  const hasExplicitEntry = Object.prototype.hasOwnProperty.call(overrides, "syncEntry");
  const explicitEntry = overrides.syncEntry;
  const vendoredEntry = hasExplicitEntry ? explicitEntry : resolveVendoredSync();
  if (vendoredEntry) {
    const kind = hasExplicitEntry ? "entry" : "vendored";
    return {
      kind,
      command: nodeBin,
      args: [vendoredEntry],
      display: `${nodeBin} ${vendoredEntry}`,
    };
  }

  const syncPackage = overrides.syncPackage ?? "@cmnwlth/sync@0.1.11";
  const npxBin = overrides.npxBin ?? "npx";
  return {
    kind: "npx",
    command: npxBin,
    args: ["-y", syncPackage],
    display: `${npxBin} -y ${syncPackage}`,
  };
}

/**
 * True iff a sync daemon is live for `brainDir`: a recorded pid in `.commonwealth/sync.pid` whose
 * process still exists (ADR-0032 arbitration — the daemon owns sync, so the hooks stand down).
 * Inlined pid check (mirrors packages/sync/src/daemon.ts and the statusline) so the hook doesn't
 * import the sync package at runtime. Never throws.
 */
async function daemonIsRunning(brainDir) {
  try {
    const raw = await fs.readFile(path.join(brainDir, ".commonwealth", "sync.pid"), "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(pid)) return false;
    process.kill(pid, 0); // signal 0 = existence check; throws ESRCH when the process is gone
    return true;
  } catch {
    return false;
  }
}

/** Keep a child-process diagnostic short enough for a one-line deferred receipt. */
function processFailureDetail(res) {
  const text = `${res?.stderr ?? ""}`.trim().replace(/\s+/g, " ");
  if (text.length > 0) return text.slice(0, 300);
  if (res?.error) return String(res.error).trim().replace(/\s+/g, " ").slice(0, 300);
  return "no diagnostic output";
}

/**
 * Execute `--version` through the hook's live curate resolution (#222). This is intentionally in
 * the plugin hook module: `doctor` imports it from the installed plugin, guaranteeing that its
 * report names and exercises the exact vendored-or-npx path capture will use.
 */
export async function probeCurateRuntime(overrides = {}) {
  const runtime = resolveCurateRuntime(overrides);
  const res = await run(runtime.command, [...runtime.args, "--version"], {
    timeoutMs: overrides.timeoutMs ?? 30_000,
  });
  return {
    kind: runtime.kind,
    command: runtime.display,
    ok: res.code === 0,
    code: res.code,
    version: res.code === 0 ? res.stdout.trim() : undefined,
    error: res.code === 0 ? undefined : processFailureDetail(res),
  };
}

export function realDeps(overrides = {}) {
  const host = overrides.host ?? "claude";
  const extractorFactory = overrides.createExtractor ?? createExtractor;
  const extractor = extractorFactory({
    host,
    run,
    claudeBin: overrides.claudeBin,
    codexBin: overrides.codexBin,
    timeoutMs: overrides.extractionTimeoutMs ?? EXTRACTION_TIMEOUT_MS,
    schemaPath: overrides.schemaPath,
  });

  // Curate runtime, resolved ONCE (matters for the per-turn UserPromptSubmit hook, #194):
  //   1. an explicit `overrides.curateEntry` (tests / local dev);
  //   2. else the plugin's VENDORED `vendor/curate/index.js` when present — the fast path: a direct
  //      `node <entry>`, no `npx -y` registry resolution on every turn;
  //   3. else the PUBLISHED `@cmnwlth/curate` via `npx -y` (#62) — a bare git-clone install has no
  //      vendor/, and npx pulls `better-sqlite3`'s prebuild transitively. Fine once-per-session,
  //      slower per-turn.
  const curateRuntime = resolveCurateRuntime(overrides);
  const runCurate = (args, runOpts) =>
    run(curateRuntime.command, [...curateRuntime.args, ...args], runOpts);

  // Sync runtime, resolved ONCE (ADR-0032): the daemonless lifecycle hooks drive the sync package's
  // `sync` subcommand, which runs the same engine as the daemon (commit → pull --rebase → push,
  // secret scrub, cross-process lock, bounded retry). Vendored fast path → npx fallback, mirroring
  // curate (ADR-0026). `--dir <brain>` pins the brain the hook already resolved.
  const syncRuntime = resolveSyncRuntime(overrides);

  async function getContext(brain, cwd) {
    const res = await runCurate(["context", "--cwd", cwd], {
      env: { COMMONWEALTH_BRAIN_DIR: brain },
    });
    if (res.code !== 0) return "";
    return res.stdout.trimEnd();
  }

  /**
   * Prompt-scoped context for UserPromptSubmit (#194): the query branch of curate's `context`
   * (→ `selectRelevant({ query })` → FTS). Capped small for per-turn relevance/brevity and hard
   * time-bounded so a slow query never hangs the turn. Empty stdout (no match) → "" → inject
   * nothing (the relevance gate).
   */
  async function getContextQuery(brain, cwd, query) {
    const res = await runCurate(["context", "--cwd", cwd, "--query", query, "--limit", "5"], {
      env: { COMMONWEALTH_BRAIN_DIR: brain },
      timeoutMs: CONTEXT_QUERY_TIMEOUT_MS,
    });
    if (res.code !== 0) return "";
    return res.stdout.trimEnd();
  }

  async function capture(brain, cwd, candidates) {
    // Pipe candidates on plain stdin: curate's `capture` reads stdin when `--from` is
    // absent. (`--from -` would be treated as a literal file path and fail.)
    const res = await runCurate(["capture", "--cwd", cwd], {
      input: JSON.stringify(candidates),
      env: { COMMONWEALTH_BRAIN_DIR: brain },
    });
    // `capture` prints one line per note to stdout, each carrying its kind + title (and a
    // `promoted` prefix when autoPromote landed it in canon). Parse them into structured notes so
    // the receipt can show WHAT was remembered, not just a count (#204).
    if (res.code !== 0) {
      return {
        captured: 0,
        failed: true,
        reason: "curate-runtime",
        runtime: curateRuntime.display,
        code: res.code,
        error: processFailureDetail(res),
      };
    }
    const notes = parseCaptureLines(res.stdout);
    // The LLM curation verdict summary (ADR-0030), when the pass did something — threaded into the
    // receipt so it can report superseded/contradiction/trivia counts.
    const verdicts = parseVerdictSummary(res.stdout);
    return { captured: notes.length, notes, ...(verdicts ? { verdicts } : {}) };
  }

  /**
   * LLM curation pass (ADR-0030), fail-open by construction. Two steps, both off the per-turn hot
   * path (this runs in the detached SessionEnd/PreCompact worker):
   *   1. `curate neighbors` — DETERMINISTIC, offline: attaches each candidate's nearest-canon
   *      neighbors AND reports the `llmCurator` flag. Flag off (or out-of-scope / no brain) →
   *      `enabled: false` → return the candidates unchanged (classifier never runs).
   *   2. ONE batched classifier call via the ADR-0027 host runtime → a verdict per candidate.
   * ANY failure (neighbors non-zero, unparseable output, classifier missing/timeout/garbage) returns
   * the ORIGINAL candidates unannotated with a single stderr breadcrumb, so capture degrades to
   * today's DISTINCT behavior — a classifier can only ADD a verdict, never drop a candidate.
   */
  async function classifyCandidates(brain, cwd, candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return candidates;
    try {
      const neigh = await runCurate(["neighbors", "--cwd", cwd], {
        input: JSON.stringify(candidates),
        env: { COMMONWEALTH_BRAIN_DIR: brain },
      });
      if (neigh.code !== 0) return candidates;
      let parsed;
      try {
        parsed = JSON.parse(neigh.stdout.trim());
      } catch {
        return candidates;
      }
      // Flag off, or nothing to classify → skip the model call entirely.
      if (!parsed || parsed.enabled !== true || !Array.isArray(parsed.candidates)) {
        return candidates;
      }

      const classifierFactory = overrides.createClassifier ?? createClassifier;
      const classifier = classifierFactory({
        host,
        run,
        claudeBin: overrides.claudeBin,
        codexBin: overrides.codexBin,
        ...(overrides.classifyTimeoutMs !== undefined
          ? { timeoutMs: overrides.classifyTimeoutMs }
          : {}),
        ...(overrides.classifySchemaPath !== undefined
          ? { schemaPath: overrides.classifySchemaPath }
          : {}),
      });
      const res = await classifier.classify({ candidates: parsed.candidates, cwd });
      if (res.ok !== true || !Array.isArray(res.candidates)) {
        console.error(
          `[commonwealth] llmCurator: classifier ${res?.reason ?? "failed"}; ` +
            `proceeding with unclassified candidates (DISTINCT).`,
        );
        return candidates;
      }
      return res.candidates;
    } catch (err) {
      console.error(
        `[commonwealth] llmCurator: curation pass errored (${err instanceof Error ? err.message : err}); ` +
          `proceeding with unclassified candidates (DISTINCT).`,
      );
      return candidates;
    }
  }

  /**
   * Refresh the ambient status cache for `brain` (#197) by shelling to curate's `status-cache`
   * (with the brain in `$COMMONWEALTH_BRAIN_DIR`, mirroring `capture`). Best-effort: any failure
   * is swallowed so a broken cache can never break SessionEnd. `cwd` is unused today but kept in
   * the signature so a future per-project status can resolve from it.
   */
  async function refreshStatus(brain, _cwd) {
    try {
      await runCurate(["status-cache"], { env: { COMMONWEALTH_BRAIN_DIR: brain } });
    } catch {
      // Non-fatal: a stale/absent status cache only costs a staler status line.
    }
  }

  /**
   * Per-user path for the deferred session receipt (#96). Honors `$COMMONWEALTH_RECEIPT`, then a
   * `last-session.json` sibling of `$COMMONWEALTH_CONFIG` (so tests that redirect config also
   * redirect the receipt), then `~/.commonwealth/last-session.json`. Mirrors the registry path
   * resolution so all per-user state lives together.
   */
  function receiptPath() {
    if (process.env.COMMONWEALTH_RECEIPT) return process.env.COMMONWEALTH_RECEIPT;
    const filename = host === "codex" ? "last-codex-turn.json" : "last-session.json";
    if (process.env.COMMONWEALTH_CONFIG) {
      return path.join(path.dirname(process.env.COMMONWEALTH_CONFIG), filename);
    }
    return path.join(os.homedir(), ".commonwealth", filename);
  }

  /** Persist the SessionEnd receipt (best-effort; a hook must never break the session). */
  async function saveReceipt(receipt) {
    try {
      const p = receiptPath();
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, JSON.stringify(receipt), "utf8");
    } catch {
      // Non-fatal: no receipt is strictly better than a broken session start/end.
    }
  }

  /**
   * Read the pending receipt and, if it was left by a session in THIS `cwd`, consume it
   * (delete → one-shot) and return its message. A receipt for a different directory is left in
   * place (it'll be overwritten by the next SessionEnd), so a `/clear` — same cwd, immediate
   * restart — shows exactly the prior session's outcome and nothing stale. Never throws.
   */
  async function takeReceipt(cwd) {
    try {
      const p = receiptPath();
      const parsed = JSON.parse(await fs.readFile(p, "utf8"));
      if (parsed && parsed.cwd === cwd && typeof parsed.message === "string") {
        await fs.rm(p, { force: true });
        return parsed.message;
      }
    } catch {
      // No receipt / unreadable — nothing to surface.
    }
    return null;
  }

  /**
   * Per-session throttle marks for prompt-triggered capture (#194), stored next to the receipt
   * file so all per-user state lives together. One tiny file per session key so concurrent
   * sessions never contend. `key` (session id, else cwd) is sanitized to a safe filename.
   */
  function captureMarkPath(key) {
    const safe = String(key || "default")
      .replace(/[^A-Za-z0-9_.-]/g, "_")
      .slice(0, 128);
    return path.join(path.dirname(receiptPath()), `prompt-capture-${safe}.json`);
  }

  /** Read the last prompt-capture timestamp for `key`, or null when never captured. Never throws. */
  async function readCaptureMark(key) {
    try {
      const parsed = JSON.parse(await fs.readFile(captureMarkPath(key), "utf8"));
      return typeof parsed?.ts === "number" ? parsed.ts : null;
    } catch {
      return null;
    }
  }

  /** Record the prompt-capture timestamp for `key` (best-effort; a hook must never break). */
  async function writeCaptureMark(key, ts) {
    try {
      const p = captureMarkPath(key);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, JSON.stringify({ ts }), "utf8");
    } catch {
      // Non-fatal: at worst the next turn re-evaluates the throttle from scratch.
    }
  }

  /**
   * Run one lifecycle sync pass for `brain` (ADR-0032), hard-capped at `timeoutMs`. Drives the sync
   * package's `sync` subcommand (same engine as the daemon), so the plugin never forks git logic.
   * Never throws — a wedged/offline sync resolves `{ ok: false }` so the caller can fail open. A
   * timeout hard-kills the child (SIGKILL via `run`); the engine's next pass recovers any stranded
   * rebase and the stale lock is reclaimed, so an interrupted sync is always safe.
   */
  async function syncOnce(brain, { timeoutMs } = {}) {
    const res = await run(syncRuntime.command, [...syncRuntime.args, "sync", "--dir", brain], {
      timeoutMs,
    });
    return {
      ok: res.code === 0 && res.timedOut !== true,
      timedOut: res.timedOut === true,
      code: res.code,
      error: res.code === 0 ? undefined : processFailureDetail(res),
    };
  }

  /**
   * Fire-and-forget background sync for `brain` (ADR-0032 debt flush). Used when the capped
   * SessionStart sync times out: we inject stale context now and let this detached child finish the
   * pull/push. Its OWN process group (`detached: true`) + `stdio: "ignore"` + `unref()` mean it
   * outlives the hook without keeping it alive. Best-effort — a spawn failure is swallowed.
   */
  function spawnDetachedSync(brain) {
    import("node:child_process")
      .then(({ spawn }) => {
        try {
          const child = spawn(syncRuntime.command, [...syncRuntime.args, "sync", "--dir", brain], {
            detached: true,
            stdio: "ignore",
          });
          child.unref?.();
        } catch {
          // Best-effort background flush; the next SessionStart retries the debt sync anyway.
        }
      })
      .catch(() => {});
  }

  return {
    resolveBrain: realResolveBrain,
    getContext,
    getContextQuery,
    capture,
    classifyCandidates,
    refreshStatus,
    extractCandidates: extractor.extract,
    saveReceipt,
    takeReceipt,
    readCaptureMark,
    writeCaptureMark,
    syncOnce,
    spawnDetachedSync,
    isDaemonRunning: daemonIsRunning,
  };
}

// --- Inlined brain registry (mirrors @cmnwlth/core/src/registry.ts) --------------------
// Inlined as pure fs/path JS rather than `import("@cmnwlth/core")`: the hooks run as
// standalone .mjs where a bare specifier isn't resolvable at runtime, which would make
// every session silently do nothing. Keep in sync with packages/core/src/registry.ts.

const MARKER_REL = path.join(".commonwealth", "brain");
// A brain is identified by `.commonwealth/schema-version`, NOT `.commonwealth/config.json`.
// The latter name collides with the per-user scope config at `~/.commonwealth/config.json`
// (ADR-0008), so keying off it makes `$HOME` resolve as a brain and shadow the registry for
// every project under home. Mirror core's registry.ts BRAIN_IDENTITY_REL (ADR-0011, #74).
const BRAIN_IDENTITY_REL = path.join(".commonwealth", "schema-version");

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
  if (process.env.COMMONWEALTH_CONFIG) return process.env.COMMONWEALTH_CONFIG;
  return path.join(os.homedir(), ".commonwealth", "config.json");
}

/** Parse a `defaultBrain`/brain-pointer field: bare string or `{ brain, remote }`; null otherwise. */
function parseBrainField(raw) {
  if (typeof raw === "string" && raw.length > 0) return { brain: raw };
  if (raw && typeof raw === "object" && typeof raw.brain === "string" && raw.brain.length > 0) {
    return { brain: raw.brain, ...(typeof raw.remote === "string" ? { remote: raw.remote } : {}) };
  }
  return null;
}

/**
 * Turn a `JSON.parse` failure into a human message that names the failure LOCATION when the runtime
 * supplies a byte position (deriving `line`/`column` from `raw`); otherwise the raw message. Mirror
 * of core's `describeJsonError` (keep in sync with packages/core/src/registry.ts).
 */
function describeJsonError(err, raw) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/line \d+ column \d+/i.test(msg)) return msg;
  const posMatch = msg.match(/position (\d+)/i);
  if (!posMatch) return msg;
  const pos = Number.parseInt(posMatch[1], 10);
  if (!Number.isFinite(pos)) return msg;
  const upto = raw.slice(0, pos);
  const line = upto.split("\n").length;
  const column = pos - upto.lastIndexOf("\n");
  return `${msg} (line ${line} column ${column})`;
}

/**
 * Load + CLASSIFY the config's rules + defaultBrain (ADR-0024), with the legacy scope `allow`/`deny`
 * folded in as sugar `prefix` rules (a `deny` entry → deny rule; an `allow` entry → bare-allow rule)
 * so this single pass IS the scope gate (ADR-0024 §3, retiring `isInScope`). Sugar rules are appended
 * AFTER the authored rules so an authored `brain` route wins any exact-specificity tie.
 *
 * Returns `{ status: "missing" }` when there is no file (safe to start empty), `{ status: "corrupt",
 * error }` when the file EXISTS but doesn't parse as a JSON object (a hand-edit typo — must NOT be
 * treated as empty, #210), or `{ status: "ok", rules, defaultBrain }`. Mirror of core's registry
 * parsing (kept in sync with packages/core/src/registry.ts).
 */
async function loadRegistryData(registryPath) {
  const raw = await readFileOrNull(registryPath);
  if (raw === null) return { status: "missing" };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { status: "corrupt", error: describeJsonError(err, raw) };
  }
  // Parsed-but-not-an-object (`[]`, `"x"`, `42`, `null`) is not a usable config — surface it loudly
  // rather than silently degrading to "no rules" (#210). `{}` stays valid/empty.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "corrupt", error: "config must be a JSON object" };
  }
  const rules = Array.isArray(parsed.rules)
    ? parsed.rules.filter((r) => r && typeof r === "object" && (r.repo || r.org || r.prefix))
    : [];
  const strList = (v) =>
    Array.isArray(v) ? v.filter((e) => typeof e === "string" && e.length > 0) : [];
  for (const d of strList(parsed.deny)) rules.push({ prefix: d, deny: true });
  for (const a of strList(parsed.allow)) rules.push({ prefix: a });
  return { status: "ok", rules, defaultBrain: parseBrainField(parsed.defaultBrain) };
}

/** Reduce a git remote URL to `owner/repo` (mirror of core's slugFromRemote, ADR-0015). */
function slugFromRemote(remote) {
  let s = remote.trim().replace(/\.git$/i, "");
  s = s.replace(/^[a-z]+:\/\//i, "").replace(/^[^@]+@/, "");
  s = s.replace(/^[^/:]+[:/]/, "");
  const parts = s.split("/").filter((p) => p.length > 0);
  return parts.length === 0 ? null : parts.slice(-2).join("/");
}

/**
 * The cwd's git identity (`owner/repo` from `origin`) for `repo`/`org` rule matching (ADR-0024).
 * Uses a single `git config` call so worktrees and clones resolve correctly — a worktree's `.git`
 * is a file pointing at the main repo, where `origin` lives, and git handles that transparently.
 * Falls back to the repo-root / cwd basename, mirroring core's `resolveProjectSource`. Called
 * lazily — only when an identity rule is present — so path-only registries never invoke git.
 */
async function gitOriginSlug(startDir) {
  let root = null;
  for (const dir of walkUp(startDir)) {
    try {
      await fs.stat(path.join(dir, ".git"));
      root = dir;
      break;
    } catch {
      // no .git here — keep walking up
    }
  }
  if (root === null) return path.basename(startDir);
  const res = await run("git", ["-C", root, "config", "--get", "remote.origin.url"], {
    timeoutMs: 3000,
  });
  const url = res.code === 0 ? res.stdout.trim() : "";
  const slug = url.length > 0 ? slugFromRemote(url) : null;
  return slug ?? path.basename(root);
}

// --- Rule engine (mirror of core registry.ts matchRules; ADR-0024) --------------------
const TIER_REPO = 4;
const TIER_ORG = 3;
const TIER_PREFIX = 2;
const TIER_STAR = 1;

function ruleIsCatchAll(rule) {
  return rule.repo === "*" || rule.org === "*" || rule.prefix === "*";
}

/** A rule's matcher key (mirror of core's ruleMatcherKey), for the local-over-shared shadow drop. */
function ruleMatcherKeyJs(rule) {
  if (ruleIsCatchAll(rule)) return "*";
  if (rule.repo) return `repo:${rule.repo.toLowerCase()}`;
  if (rule.org) return `org:${rule.org.replace(/\/\*$/, "").toLowerCase()}`;
  if (rule.prefix) return `prefix:${expandPath(rule.prefix)}`;
  return null;
}

/**
 * Enforce "local overrides shared" (ADR-0024 §5): drop any `origin: "shared"` rule whose matcher is
 * also carried by a local rule (origin absent/"local", incl. the folded allow/deny sugar). Mirror of
 * core's dropShadowedShared; defensive (the per-user config normally already holds this invariant).
 */
function dropShadowedSharedJs(rules) {
  const localKeys = new Set();
  for (const r of rules) {
    if (r.origin !== "shared") {
      const k = ruleMatcherKeyJs(r);
      if (k) localKeys.add(k);
    }
  }
  if (localKeys.size === 0) return rules;
  return rules.filter((r) => {
    if (r.origin !== "shared") return true;
    const k = ruleMatcherKeyJs(r);
    return !(k !== null && localKeys.has(k));
  });
}

/** Highest-tier matcher of `rule` that matches `(start, slug)`, or null. Mirror of core scoreRule. */
function scoreRule(rule, start, slug) {
  if (ruleIsCatchAll(rule)) return { tier: TIER_STAR, len: 0 };
  let tier = 0;
  let len = 0;
  if (rule.repo && slug && slug.toLowerCase() === rule.repo.toLowerCase()) {
    tier = TIER_REPO;
    len = rule.repo.length;
  }
  if (tier < TIER_ORG && rule.org) {
    const owner = rule.org.replace(/\/\*$/, "").toLowerCase();
    const slugOwner = slug && slug.includes("/") ? (slug.split("/")[0] ?? "").toLowerCase() : "";
    if (slugOwner && slugOwner === owner) {
      tier = TIER_ORG;
      len = owner.length;
    }
  }
  if (tier < TIER_PREFIX && rule.prefix) {
    const p = expandPath(rule.prefix);
    if (isUnder(start, p)) {
      tier = TIER_PREFIX;
      len = p.length;
    }
  }
  return tier > 0 ? { tier, len } : null;
}

/**
 * Evaluate the ruleset for `(start, slug)`, returning the three-way outcome (mirror of core's
 * `matchRules`): `null` = no rule matched (caller falls through to env); `{ kind: "denied" }` = a
 * deny rule won; `{ kind: "brain", brain }` = routed (its brain, else the default brain);
 * `{ kind: "none" }` = a bare allow won with no default brain (a matched no-op that STOPS resolution,
 * never falling through to the env brain). Most-specific wins; deny breaks ties.
 */
function matchRulesJs(start, slug, rules, defaultBrain) {
  let best = null;
  for (const rule of rules) {
    const m = scoreRule(rule, start, slug);
    if (!m) continue;
    if (
      !best ||
      m.tier > best.tier ||
      (m.tier === best.tier && m.len > best.len) ||
      (m.tier === best.tier && m.len === best.len && rule.deny === true && best.rule.deny !== true)
    ) {
      best = { tier: m.tier, len: m.len, rule };
    }
  }
  if (!best) return null;
  const { rule } = best;
  if (rule.deny) return { kind: "denied" };
  if (rule.brain) return { kind: "brain", brain: expandPath(rule.brain) };
  if (defaultBrain) return { kind: "brain", brain: expandPath(defaultBrain.brain) };
  return { kind: "none" };
}

/**
 * Resolve `startDir` in ONE pass that is both routing AND scope (ADR-0024 §3), returning the
 * outcome `{ kind: "brain", brain } | { kind: "denied" } | { kind: "none" } | { kind:
 * "corrupt-config", path, error }`. Order: (1) nearest valid `.commonwealth/brain` marker (#68) →
 * (2) nearest ancestor that is itself a brain (#74) → (3) the unified ruleset, with the legacy
 * scope allow/deny folded in as sugar (ADR-0024 §3/§7): most-specific wins, deny → `denied` → (4)
 * `$COMMONWEALTH_BRAIN_DIR` → (5) `corrupt-config` when the file existed but was unparseable and
 * nothing above resolved (#210), else `none`. Explicit pins (marker, self-is-brain, env) still win
 * over a corrupt config. Mirror of core's `resolveBrain`; never throws. Exported for tests so the
 * REAL production path (not a stubbed dep) is covered.
 */
export async function realResolveBrain(startDir) {
  if (typeof startDir !== "string" || startDir.length === 0) return { kind: "none" };
  const start = path.resolve(startDir);

  for (const dir of walkUp(start)) {
    const raw = await readFileOrNull(path.join(dir, MARKER_REL));
    if (raw !== null) {
      const target = raw.trim();
      if (target.length > 0) {
        const resolved = expandPath(target, dir);
        // Skip a dangling marker (missing target) so a stale one falls through to the
        // registry instead of hijacking capture to a dead brain path (#68).
        if (await isDir(resolved)) return { kind: "brain", brain: resolved };
      }
    }
  }
  for (const dir of walkUp(start)) {
    if (await isFile(path.join(dir, BRAIN_IDENTITY_REL))) return { kind: "brain", brain: dir };
  }

  const registryPath = resolveRegistryPath();
  const load = await loadRegistryData(registryPath);
  if (load.status === "ok") {
    const rules = dropShadowedSharedJs(load.rules);
    if (rules.length > 0) {
      // Resolve git identity once, and only when an identity rule could use it (path-only is cheap).
      const needsSlug = rules.some((r) => (r.repo && r.repo !== "*") || (r.org && r.org !== "*"));
      const slug = needsSlug ? await gitOriginSlug(start) : null;
      const m = matchRulesJs(start, slug, rules, load.defaultBrain);
      // A matched rule STOPS resolution (brain / denied / none) — never falls through to env.
      if (m) return m;
    }
  }

  // Env pin still wins over a corrupt config — the operator told us exactly which brain to use.
  const env = process.env.COMMONWEALTH_BRAIN_DIR;
  if (env && env.length > 0) return { kind: "brain", brain: path.resolve(env) };

  // A file that EXISTS but didn't parse is a loud `corrupt-config` (so a one-char hand-edit typo
  // can't silently disable capture, #210); a missing file is a plain `none`.
  if (load.status === "corrupt") {
    return { kind: "corrupt-config", path: registryPath, error: load.error };
  }
  return { kind: "none" };
}

/**
 * Back-compat wrapper: the collapsed brain path (`string | null`) over {@link realResolveBrain},
 * mapping both `denied` and `none` to `null`. Exported for tests / callers that only need "which
 * brain, if any".
 */
export async function realResolveBrainDir(startDir) {
  const r = await realResolveBrain(startDir);
  return r.kind === "brain" ? r.brain : null;
}

/**
 * Parse a `claude -p` reply into a candidate array. Tolerates surrounding prose or a
 * ```json code fence by extracting the first top-level `[ ... ]`. Returns [] on any failure.
 * Exported for unit testing.
 */
export function parseCandidateArray(text) {
  return parseExtractionOutput(text) ?? [];
}
