// Codex lifecycle adapter (#225). Codex and Claude share the hook core, brain registry, capture
// worker, and curation gates; this entry owns only Codex's event semantics and host marker.
//
// Codex Stop is a TURN boundary, not SessionEnd. Capture remains detached, errors are written to
// stderr, and this process always exits successfully so Commonwealth can never block the host.
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  attachReceipt,
  buildSessionStartOutput,
  buildUserPromptSubmitOutput,
  DISABLE_HOOKS_ENV,
  launchCaptureWorker,
  promptCaptureIntervalMs,
  realDeps,
  sessionStart,
  shouldCaptureNow,
  userPromptSubmit,
} from "./lib.mjs";

const SUPPORTED_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PreCompact", "Stop"]);

/** Read all hook JSON from stdin. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** One host-prefixed throttle key prevents Claude/Codex state from suppressing each other. */
export function codexCaptureMarkKey(input) {
  const identity =
    typeof input?.session_id === "string" && input.session_id.length > 0
      ? input.session_id
      : typeof input?.cwd === "string"
        ? input.cwd
        : "";
  return `codex:${identity}`;
}

/**
 * Keep detached-worker argv small and trusted. Codex hook payloads can contain prompts or final
 * assistant messages; the worker needs only routing/transcript identifiers plus our forced host
 * and boundary. The transcript itself remains on disk at `transcript_path`.
 */
export function codexCapturePayload(input, boundary) {
  const payload = {};
  for (const key of ["cwd", "transcript_path", "session_id", "turn_id"]) {
    if (typeof input?.[key] === "string" && input[key].length > 0) payload[key] = input[key];
  }
  return {
    ...payload,
    commonwealth_host: "codex",
    commonwealth_capture_boundary: boundary,
  };
}

/** Launch a detached capture and fail visibly when even the worker could not be started. */
async function launchCodexCapture(input, boundary, deps, opts) {
  const workerPath =
    opts.workerPath ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), "capture-worker.mjs");
  const child = await opts.launchCapture(codexCapturePayload(input, boundary), { workerPath });
  if (!child) throw new Error(`could not launch the detached ${boundary} capture worker`);
  await deps.writeCaptureMark(codexCaptureMarkKey(input), opts.now);
}

/**
 * Testable Codex event dispatcher. Context events return their JSON output object; capture events
 * return null and therefore write nothing to stdout.
 */
export async function runCodexHook(event, input, options = {}) {
  const env = options.env ?? process.env;
  if (env[DISABLE_HOOKS_ENV] === "1") return null;
  if (!SUPPORTED_EVENTS.has(event)) throw new Error(`unsupported Codex hook event: ${event}`);

  const deps = options.deps ?? realDeps({ host: "codex" });
  const now = options.now ?? Date.now();
  const opts = {
    env,
    now,
    workerPath: options.workerPath ?? env.COMMONWEALTH_CAPTURE_WORKER,
    launchCapture: options.launchCapture ?? launchCaptureWorker,
  };

  if (event === "SessionStart") {
    const context = await sessionStart(input, deps);
    const base = buildSessionStartOutput(context);
    const receipt =
      typeof deps.takeReceipt === "function" ? await deps.takeReceipt(input?.cwd) : null;
    return attachReceipt(base, receipt);
  }

  if (event === "UserPromptSubmit") {
    // Codex Stop is already the write boundary for completed turns. Capturing here would inspect
    // an incomplete turn and then duplicate the Stop worker; this event is intentionally read-only.
    return buildUserPromptSubmitOutput(await userPromptSubmit(input, deps));
  }

  if (event === "PreCompact") {
    await launchCodexCapture(input, "compaction", deps, opts);
    return null;
  }

  // A Stop hook can be re-entered when another Stop hook asks the agent to continue. Commonwealth
  // never asks that, and must not recursively capture such a synthetic boundary.
  if (input?.stop_hook_active === true) return null;

  const intervalMs = promptCaptureIntervalMs(env);
  const key = codexCaptureMarkKey(input);
  const lastMark = await deps.readCaptureMark(key);
  if (!shouldCaptureNow({ lastMark, now, intervalMs })) return null;
  await launchCodexCapture(input, "turn", deps, opts);
  return null;
}

export async function main() {
  if (process.env[DISABLE_HOOKS_ENV] === "1") return;
  const event = process.argv[2] ?? "";
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error("hook input was not valid JSON");
  }
  const output = await runCodexHook(event, input);
  if (output) process.stdout.write(JSON.stringify(output));
}

const isMain =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((error) => {
    console.error(
      "[commonwealth] codex hook error:",
      error instanceof Error ? error.message : error,
    );
    // Deliberately do not set a non-zero exit code: a hook failure must never block Codex.
  });
}
