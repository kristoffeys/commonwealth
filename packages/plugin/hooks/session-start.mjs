// SessionStart hook entry. Reads the hook JSON from stdin, resolves the brain + scope, and
// prints the team-brain context to stdout (which Claude Code injects into the model's
// context). Run via `node session-start.mjs` from hooks.json — no shebang needed.
//
// Hard rule: a hook must never break the session. On ANY error we log to stderr and exit 0
// (printing nothing), so a missing brain, unreadable config, or thrown dep degrades to
// "inject nothing" rather than a failed session start.
import { buildSessionStartOutput, realDeps, sessionStart } from "./lib.mjs";

/** Read all of stdin as a UTF-8 string. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    input = {};
  }
  const context = await sessionStart(input, realDeps());
  const out = buildSessionStartOutput(context);
  if (out) {
    // JSON stdout: `additionalContext` is injected into the model and `systemMessage` (the
    // value receipt) is shown to the user. When there is nothing to inject, write nothing.
    process.stdout.write(JSON.stringify(out));
  }
}

main().catch((err) => {
  // Never propagate to stdout; stderr is safe (Claude Code shows it as hook diagnostics).
  console.error("[commons] session-start hook error:", err instanceof Error ? err.message : err);
  process.exit(0);
});
