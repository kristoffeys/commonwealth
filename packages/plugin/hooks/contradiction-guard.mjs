// PreToolUse contradiction guard entry (#199, ADR-0033). Fires before every Write/Edit/Bash. It
// checks whether the pending change looks like it contradicts a recorded `decision` note and, if
// so, surfaces it — by default as a NON-BLOCKING `additionalContext` warning (the tool still runs),
// or as a permission `ask` prompt when the brain opts into `contradictionGuard.mode: "ask"`.
//
// Conservative by construction (see ADR-0033): opt-in (the `contradictionGuard` flag is default
// OFF), inert without an embeddings provider, decision-notes-only, fail-open under a hard time
// budget, and deduped to one nudge per decision per session. All the control flow lives in
// `contradictionGuard()` in lib.mjs (deps-injected for tests); this entry just does stdin/stdout.
//
// Hard rule: a hook must never break the session. On ANY error — and on the recursion guard — we
// write nothing and exit 0, so the tool proceeds exactly as if the guard were absent.
import { contradictionGuard, DISABLE_HOOKS_ENV, realDeps } from "./lib.mjs";

/** Read all of stdin as a UTF-8 string. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  // Recursion guard (#104): the extraction/classifier `claude -p` children run with this set, so
  // their own tool calls must not re-fire the guard (which would recurse and add latency).
  if (process.env[DISABLE_HOOKS_ENV] === "1") return;

  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    input = {};
  }

  const out = await contradictionGuard(input, realDeps());
  if (out) process.stdout.write(JSON.stringify(out));
}

main().catch((err) => {
  console.error(
    "[commonwealth] contradiction-guard hook error:",
    err instanceof Error ? err.message : err,
  );
  process.exit(0);
});
