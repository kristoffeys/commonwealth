import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex, initBrain, search, writeNote, type NewNoteInput } from "@cmnwlth/core";

/**
 * `commonwealth demo` (#137) — a 60-second, zero-setup taste of the product. It scaffolds a
 * checked-in *fictional* team's brain into a throwaway tmpdir (the real registry, plugin, and
 * daemon are never touched), then replays a few scripted `recall` questions whose answers live
 * ONLY in that team's decision/memory notes — the reveal being that keyword search over the brain
 * surfaces a decision no README could state. Auto-cleans up unless `--keep`.
 *
 * Deliberately NOT conversational recall (#108 is unbuilt) and NOT repo mining (`--from` is a
 * deferred follow-up): the promise is "runs in a minute, no team, no real repos".
 */

/** The fictional team's canon. Each scripted question is answered by exactly one of these notes. */
const FIXTURE_SOURCE = "meridian/payments";

const FIXTURE_NOTES: NewNoteInput[] = [
  {
    kind: "decision",
    title: "Require an Idempotency-Key on every payment write",
    source: FIXTURE_SOURCE,
    tags: ["payments", "reliability"],
    body:
      "All payment write endpoints require an Idempotency-Key header. We dedupe on that key for " +
      "24 hours and return the original response, so a client that retries after a network timeout " +
      "never double-charges the customer. Reads are exempt.",
    fields: { deciders: ["ana", "wei"] },
  },
  {
    kind: "decision",
    title: "Keep the money ledger in Postgres, not DynamoDB",
    source: FIXTURE_SOURCE,
    tags: ["payments", "data"],
    body:
      "The account balance ledger lives in Postgres because we need serializable transactions to " +
      "move money between accounts atomically. DynamoDB's eventual consistency was ruled out for " +
      "balances — a stale read there could authorize an overdraft.",
    fields: { deciders: ["wei"] },
  },
  {
    kind: "decision",
    title: "Sign outbound webhooks with HMAC-SHA256",
    source: FIXTURE_SOURCE,
    tags: ["payments", "security"],
    body:
      "Every outbound webhook carries an X-Signature header: HMAC-SHA256 of the raw body with the " +
      "endpoint's secret. Receivers must reject any signature older than a 5-minute tolerance window " +
      "to block replay attacks.",
    fields: { deciders: ["ana"] },
  },
  {
    kind: "memory",
    title: "Sandbox test cards",
    source: FIXTURE_SOURCE,
    tags: ["payments", "testing"],
    body:
      "In sandbox, card 4242 4242 4242 4242 always succeeds. Card 4000 0000 0000 0002 always " +
      "triggers a declined payment, and 4000 0000 0000 9995 triggers an insufficient-funds decline. " +
      "These never hit a real network.",
  },
  {
    kind: "work-state",
    title: "Migrating settlement onto the new ledger",
    source: FIXTURE_SOURCE,
    tags: ["payments"],
    body:
      "Moving the nightly settlement job off the legacy balances table onto the Postgres ledger. " +
      "Double-writing today; cutover once reconciliation runs clean for a week.",
    fields: { status: "in-progress" },
  },
];

/** One scripted beat: the human question, the search query behind it, and the note it should surface. */
interface DemoBeat {
  question: string;
  query: string;
  /** Substring of the answering note's title — asserted in tests so the reveal never rots. */
  expectTitle: string;
}

const DEMO_SCRIPT: DemoBeat[] = [
  {
    // FTS5 is exact-token AND (no stemming): every term must appear verbatim in the answering note.
    question: "How do we stop a client from double-charging a customer when it retries a payment?",
    query: "idempotency dedupe retries",
    expectTitle: "Idempotency-Key",
  },
  {
    question: "Which database backs the money balances, and why not DynamoDB?",
    query: "ledger postgres serializable",
    expectTitle: "money ledger in Postgres",
  },
  {
    question: "What card number triggers a declined payment in the sandbox?",
    query: "sandbox declined card",
    expectTitle: "Sandbox test cards",
  },
];

/** Injectable surfaces so tests capture output and control the tmpdir. */
export interface DemoEnv {
  /** Make the throwaway brain dir. */
  mkTemp: () => Promise<string>;
  /** Remove the brain dir (skipped when `keep`). */
  cleanup: (dir: string) => Promise<void>;
  /** Emit a line to the user. */
  out: (line: string) => void;
  /** Keep the brain dir and print its path instead of deleting. */
  keep: boolean;
}

/** Real surfaces for the CLI. */
export function defaultDemoEnv(keep: boolean, out: (line: string) => void): DemoEnv {
  return {
    mkTemp: () => fs.mkdtemp(path.join(os.tmpdir(), "cw-demo-")),
    cleanup: (dir) => fs.rm(dir, { recursive: true, force: true }),
    out,
    keep,
  };
}

/** Result of a demo run: where the brain was built and what each beat surfaced (for tests). */
export interface DemoResult {
  brainDir: string;
  kept: boolean;
  beats: Array<{ question: string; topTitle: string | null }>;
}

/**
 * Scaffold the fixture brain, index it, and replay the scripted questions, narrating to `env.out`.
 * Returns each beat's top hit so a test can assert the reveal still resolves. Cleans up the brain
 * unless `env.keep`.
 */
export async function runDemo(env: DemoEnv): Promise<DemoResult> {
  const brainDir = await env.mkTemp();
  const beats: DemoResult["beats"] = [];
  try {
    await initBrain(brainDir, { name: "meridian-demo" });
    for (const note of FIXTURE_NOTES) await writeNote(brainDir, note);
    await buildIndex(brainDir);

    env.out("");
    env.out("  Commonwealth demo — a fictional payments team's brain.");
    env.out("  Nothing here is in any README; the answers live only in the team's notes.");
    env.out("");

    for (const beat of DEMO_SCRIPT) {
      const hits = await search(brainDir, beat.query, { limit: 1 });
      const top = hits[0] ?? null;
      beats.push({ question: beat.question, topTitle: top?.title ?? null });
      env.out(`  ❯ ${beat.question}`);
      if (top) {
        env.out(`    → ${top.title}`);
        if (top.snippet) env.out(`      ${top.snippet.replace(/\s+/g, " ").trim()}`);
      } else {
        env.out("    → (no match)");
      }
      env.out("");
    }

    env.out("  That's recall over a git-backed markdown brain — no server, no account.");
    env.out("  Start your own: `commonwealth init`.");
    env.out("");

    return { brainDir, kept: env.keep, beats };
  } finally {
    if (env.keep) env.out(`  (brain kept at ${brainDir})`);
    else await env.cleanup(brainDir);
  }
}

/** Exposed for tests: the scripted beats, so the fixture and the reveal are asserted together. */
export const _demoScript = DEMO_SCRIPT;
