// Detached SessionEnd capture worker. `session-end.mjs` launches this as its OWN process group
// (see `launchCaptureWorker` in lib.mjs) so it survives the `/clear` teardown that kills the
// SessionEnd hook process itself. It receives the hook JSON as `argv[2]` (there is no stdin — the
// launcher spawns it with `stdio: "ignore"`), then runs the full resolve → scope → extract →
// capture → receipt pipeline via `sessionEnd`, and exits.
//
// Hard rule: a hook (and its worker) must never break the session. On ANY error we exit 0. Output
// goes nowhere (the launcher discards our stdio); the user-facing surface is the deferred receipt
// that the next SessionStart reads (#96).
import { DISABLE_HOOKS_ENV, realDeps, sessionEnd } from "./lib.mjs";

async function main() {
  // Recursion guard (#104), belt-and-suspenders: the nested `claude -p` extractor sets this, and
  // it never spawns this worker — but if it somehow did, do nothing rather than recurse.
  if (process.env[DISABLE_HOOKS_ENV] === "1") return;

  let input;
  try {
    input = JSON.parse(process.argv[2] ?? "{}");
  } catch {
    input = {};
  }
  // `await` fully so every write (capture, saveReceipt) completes before we exit.
  await sessionEnd(input, realDeps());
}

main()
  .then(() => process.exit(0))
  .catch(() => process.exit(0));
