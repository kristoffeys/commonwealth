// SessionStart hook entry. Reads the hook JSON from stdin, resolves the brain + scope, and
// prints the team-brain context to stdout (which Claude Code injects into the model's
// context). Run via `node session-start.mjs` from hooks.json — no shebang needed.
//
// Hard rule: a hook must never break the session. On ANY error we log to stderr and exit 0
// (printing nothing), so a missing brain, unreadable config, or thrown dep degrades to
// "inject nothing" rather than a failed session start.
import {
  attachReceipt,
  buildSessionStartOutput,
  DISABLE_HOOKS_ENV,
  realDeps,
  sessionStart,
} from "./lib.mjs";

/** Read all of stdin as a UTF-8 string. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  // Recursion guard (#104): a nested `claude -p` spawned by the extractor must not inject
  // context (which would recurse / pollute the extraction). Do nothing when the flag is set.
  if (process.env[DISABLE_HOOKS_ENV] === "1") return;

  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    input = {};
  }
  const deps = realDeps();
  const context = await sessionStart(input, deps);
  const base = buildSessionStartOutput(context);
  // Surface any deferred receipt from the prior session's SessionEnd (#96): a `/clear` in this
  // same directory left a one-liner explaining what was (or wasn't) captured. `takeReceipt`
  // consumes it (one-shot); `attachReceipt` folds it into `systemMessage` only.
  const receiptMessage =
    typeof deps.takeReceipt === "function" ? await deps.takeReceipt(input?.cwd) : null;
  const out = attachReceipt(base, receiptMessage);
  if (out) {
    // JSON stdout: `additionalContext` is injected into the model and `systemMessage` (the
    // value receipt + any deferred capture receipt) is shown to the user.
    process.stdout.write(JSON.stringify(out));
  }
}

main().catch((err) => {
  // Never propagate to stdout; stderr is safe (Claude Code shows it as hook diagnostics).
  console.error(
    "[commonwealth] session-start hook error:",
    err instanceof Error ? err.message : err,
  );
  process.exit(0);
});
