// SessionEnd hook entry. Reads the hook JSON from stdin (which includes `transcript_path`), then
// hands the work to a DETACHED background worker (capture-worker.mjs) and returns AT ONCE.
//
// Why detached: SessionEnd is fire-and-forget — Claude Code does not wait for it and, on `/clear`,
// tears the old session down immediately and starts the next one. Capture does an LLM extraction
// (tens of seconds), so doing it inline here means this hook process is killed mid-flight on
// `/clear` before it writes anything — which is why every `/clear` silently captured nothing
// (#190). The worker runs in its own process group (setsid via `detached: true`), so teardown
// signals don't reach it; it finishes in the background and the next SessionStart surfaces the
// receipt (#96). Run via `node session-end.mjs` from hooks.json — no shebang needed.
//
// Hard rule: a hook must never break the session. On ANY error we log to stderr and exit 0.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DISABLE_HOOKS_ENV, launchCaptureWorker } from "./lib.mjs";

/** Read all of stdin as a UTF-8 string. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  // Recursion guard (#104): this session is the nested `claude -p` the extractor spawned. Do
  // nothing — otherwise we'd extract the extractor's own transcript and spawn yet another.
  if (process.env[DISABLE_HOOKS_ENV] === "1") return;

  const raw = await readStdin();
  // The heavy lifting (extract → capture → receipt) is the worker's job; this entry only launches
  // it and returns, so the harness's fire-and-forget teardown never interrupts the real work.
  // `$COMMONWEALTH_CAPTURE_WORKER` is a test seam to substitute a stub worker; defaults to the
  // sibling capture-worker.mjs.
  const workerPath =
    process.env.COMMONWEALTH_CAPTURE_WORKER ||
    path.join(path.dirname(fileURLToPath(import.meta.url)), "capture-worker.mjs");
  await launchCaptureWorker(raw, { workerPath });
}

main().catch((err) => {
  console.error("[commonwealth] session-end hook error:", err instanceof Error ? err.message : err);
  process.exit(0);
});
