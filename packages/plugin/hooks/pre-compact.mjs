// PreCompact hook entry (#195). Fires BEFORE Claude Code compacts a long session (manual `/compact`
// or automatic context-full compaction) with the pre-compaction `transcript_path` on stdin. Capture
// runs only at SessionEnd today, so a long session that compacts and continues — then is abandoned
// or killed without a clean SessionEnd — loses the reasoning that scrolled out of the model's active
// context. Extracting once at compaction time closes that gap.
//
// Reuses the EXACT SessionEnd plumbing: hand the hook JSON to the same DETACHED capture-worker
// (capture-worker.mjs → sessionEnd), which resolves the brain, honors the scope/registry gates,
// extracts candidates from the transcript, and stages them. Detaching matters for the same reason
// as SessionEnd (#190): compaction may tear things down, and a background worker in its own process
// group survives it. Double-capture across PreCompact + SessionEnd is safe — curate's gate dedups
// staged notes. PreCompact is info-only (cannot block or inject), which is exactly what we need.
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
  // Recursion guard (#104): a nested `claude -p` (the extractor) must never trigger capture — and
  // its own sessions can compact too. Do nothing when the flag is set.
  if (process.env[DISABLE_HOOKS_ENV] === "1") return;

  const raw = await readStdin();
  // Same detached worker as SessionEnd; `$COMMONWEALTH_CAPTURE_WORKER` is the test seam.
  const workerPath =
    process.env.COMMONWEALTH_CAPTURE_WORKER ||
    path.join(path.dirname(fileURLToPath(import.meta.url)), "capture-worker.mjs");
  await launchCaptureWorker(raw, { workerPath });
}

main().catch((err) => {
  console.error("[commonwealth] pre-compact hook error:", err instanceof Error ? err.message : err);
  process.exit(0);
});
