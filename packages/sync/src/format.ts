import type { SyncSummary } from "./engine.js";

/**
 * One-line (occasionally two-line) human summary of a sync pass for the CLI/daemon log. The
 * second line is emitted only when notes were withheld for containing a secret (#99): a
 * silently-withheld note is a trust problem, so the user must always see which paths were held
 * back (they remain uncommitted in the working tree to fix). Pure function.
 */
export function formatSyncSummary(s: SyncSummary): string {
  let line =
    `[commonwealth-sync] sync: committed=${s.committed} pulled=${s.pulled} ` +
    `pushed=${s.pushed} conflicts=${s.conflicts.length}`;
  if (s.secretsBlocked.length > 0) {
    line += `\n[commonwealth-sync] withheld ${s.secretsBlocked.length} note(s) containing a secret (not committed/pushed): ${s.secretsBlocked.join(", ")}`;
  }
  return line;
}
