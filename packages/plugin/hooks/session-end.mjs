// SessionEnd hook entry. Reads the hook JSON from stdin (which includes `transcript_path`),
// resolves the brain + scope, extracts capture candidates from the transcript, and stages
// them via the review queue. Prints nothing to stdout; a one-line summary goes to stderr.
// Run via `node session-end.mjs` from hooks.json — no shebang needed.
//
// Hard rule: a hook must never break the session. On ANY error we log to stderr and exit 0.
import { DISABLE_HOOKS_ENV, realDeps, sessionEnd } from "./lib.mjs";

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
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    input = {};
  }
  const result = await sessionEnd(input, realDeps());
  if (result && result.skipped) {
    console.error(
      `[commonwealth] session-end: captured nothing (${result.reason ?? "skipped"}); ` +
        `the next session in this directory will show why`,
    );
  } else if (result && typeof result.captured === "number") {
    console.error(`[commonwealth] session-end: staged ${result.captured} candidate note(s)`);
  }
}

main().catch((err) => {
  console.error("[commonwealth] session-end hook error:", err instanceof Error ? err.message : err);
  process.exit(0);
});
