// UserPromptSubmit hook entry (#194). Fires on EVERY turn with the user's prompt on stdin. It does
// two independent things:
//
//   1. INJECT prompt-scoped context — resolve the brain + honor the scope gate (like SessionStart),
//      run the query retrieval, and print `additionalContext` JSON so Claude Code injects the notes
//      relevant to what the developer is asking right now. Synchronous, so it uses the fast
//      (vendored) curate path and a hard-bounded query; on any slowness/error it injects nothing.
//
//   2. Optionally CAPTURE — throttled ("if needed"): so a long session's knowledge isn't lost if it
//      is abandoned before PreCompact/SessionEnd, we also launch the SAME detached capture worker
//      SessionEnd uses, but at most once per `$COMMONWEALTH_PROMPT_CAPTURE_MS` (default 15m; `0`
//      disables). It runs in the background (fire-and-forget) so it never adds to turn latency, and
//      the worker self-gates on scope/brain — an out-of-scope prompt does no real work. Double
//      capture across prompt/PreCompact/SessionEnd is safe (curate dedups staged notes).
//
// Hard rule: a hook must never break the session. On ANY error we log to stderr and exit 0.
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildUserPromptSubmitOutput,
  DISABLE_HOOKS_ENV,
  launchCaptureWorker,
  promptCaptureIntervalMs,
  realDeps,
  shouldCaptureNow,
  userPromptSubmit,
} from "./lib.mjs";

/** Read all of stdin as a UTF-8 string. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Throttled prompt-triggered capture: launch the detached SessionEnd worker at most once per
 * interval per session. Best-effort and non-blocking — never throws into the turn.
 */
async function maybeCapture(raw, input, deps) {
  try {
    const intervalMs = promptCaptureIntervalMs();
    if (intervalMs <= 0) return; // disabled
    const key = input?.session_id || input?.cwd || "";
    const lastMark = await deps.readCaptureMark(key);
    if (!shouldCaptureNow({ lastMark, now: Date.now(), intervalMs })) return;
    // Mark BEFORE launching so a burst of turns doesn't fire multiple overlapping extractions.
    await deps.writeCaptureMark(key, Date.now());
    const workerPath =
      process.env.COMMONWEALTH_CAPTURE_WORKER ||
      path.join(path.dirname(fileURLToPath(import.meta.url)), "capture-worker.mjs");
    await launchCaptureWorker(raw, { workerPath });
  } catch {
    // Non-fatal: capture is opportunistic; PreCompact/SessionEnd remain the guaranteed paths.
  }
}

async function main() {
  // Recursion guard (#104): a nested `claude -p` spawned by the extractor must not inject context
  // or trigger capture.
  if (process.env[DISABLE_HOOKS_ENV] === "1") return;

  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    input = {};
  }
  const deps = realDeps();

  // 1) Inject prompt-scoped context (synchronous).
  const context = await userPromptSubmit(input, deps);
  const out = buildUserPromptSubmitOutput(context);
  if (out) process.stdout.write(JSON.stringify(out));

  // 2) Fire throttled background capture (non-blocking).
  await maybeCapture(raw, input, deps);
}

main().catch((err) => {
  console.error(
    "[commonwealth] user-prompt-submit hook error:",
    err instanceof Error ? err.message : err,
  );
  process.exit(0);
});
