import { promises as fs } from "node:fs";
import path from "node:path";
import { hasSecrets } from "./secrets.js";

/**
 * Capture receipts (ADR-0037, #266). Curation is *gated* — a veto is a normal, correct outcome —
 * but CLAUDE.md principle 4 says it must never be SILENT, and until now a dropped candidate left
 * only a free-text `reason` string on a `CurateResult` that the detached capture worker threw away
 * when it exited. `autoAdr: false` silently swallowing every decision candidate (#266) is one
 * instance; #263 and #259 were others. Nothing could aggregate, explain, or act on a drop.
 *
 * This module is the receipt: a stable machine {@link DropCategory}, whether the drop is
 * {@link DropClassification.recoverable} by the user, a plain-language cause, and a concrete next
 * action — persisted per brain so `doctor` and `status` can still answer "why is nothing landing?"
 * long after the worker that dropped the candidate exited.
 *
 * It lives in core, not curate, for the same reason {@link CaptureLogEntry} does: the WRITER is the
 * capture path (`@cmnwlth/curate`) but the READERS are `doctor` / `status` in `@cmnwlth/cli`, and
 * both depend on core. One shape, one path resolution, no cross-package drift.
 *
 * **Derived and disposable (ADR-0003).** Receipts live under the brain's gitignored `index/`
 * alongside the search index — never committed, never synced, never a second source of truth. They
 * describe candidates that never became notes, so unlike the vector index they cannot be *rebuilt*
 * from canon: a fresh clone, or `rm -rf index/`, legitimately starts with none. That is the correct
 * trade — a receipt is a diagnostic, and a diagnostic that survives into git would be a store.
 */

/**
 * Every candidate-level drop path that exists in the capture pipeline today, one enumerated value
 * each. Adding a gate means adding a value here — that is the point: the type, not a log line, is
 * what makes a new silent drop impossible to ship.
 *
 * Note what is deliberately absent: the SCOPE gate. An out-of-scope cwd (ADR-0024) declines the
 * whole session before any candidate is extracted, so it is a session-level outcome already carried
 * by the capture log's `skipped` entry — not a candidate drop, and not a receipt.
 */
export type DropCategory =
  /** The secret scanner matched somewhere in the candidate (#16/#99). */
  | "secret-detected"
  /** A `decision` candidate vetoed because the brain has `autoAdr` off (ADR-0009/#266). */
  | "autoadr-vetoed"
  /** Empty title, or a body under the relevance floor. */
  | "too-thin"
  /** Token-set Jaccard matched an existing canon/staged note (ADR-0007). */
  | "duplicate-lexical"
  /** Embedding cosine matched an existing canon note (ADR-0021). */
  | "duplicate-semantic"
  /** The LLM curation classifier judged it a restatement (ADR-0030). */
  | "duplicate-llm"
  /** The durability judge classified it as ephemera (ADR-0030). */
  | "trivia"
  /** The candidate failed note validation and was dropped on its own (#88). */
  | "invalid"
  /** A pluggable curator (ADR-0007) declined with a reason this version has no category for. */
  | "unknown";

/** The structured drop classification: what a receipt says, minus when/where it happened. */
export interface DropClassification {
  /** Stable machine category — safe to aggregate on and to switch over. */
  category: DropCategory;
  /**
   * True when a user or config change would have let this candidate through. Drives the loud/quiet
   * split: a recoverable drop is something the user probably did not intend (`autoAdr` off, a
   * pasted credential, a one-line body); a non-recoverable one — a duplicate, trivia — is the gate
   * working as designed and must not nag.
   */
  recoverable: boolean;
  /** Plain-language cause, printable as-is. Never contains candidate body text. */
  cause: string;
  /** The concrete next step, or null when the drop is simply the correct outcome. */
  nextAction: string | null;
}

/** Context {@link dropFor} folds into the cause/next-action text. */
export interface DropContext {
  /** Id of the note a duplicate candidate restates. */
  duplicateOf?: string;
  /** Extra machine detail (a validation error, an unrecognized curator reason). */
  detail?: string;
}

/** Short human label per category, for the aggregate one-liners `status`/`doctor` print. */
export const DROP_LABELS: Record<DropCategory, string> = {
  "secret-detected": "secret-blocked",
  "autoadr-vetoed": "autoAdr-vetoed",
  "too-thin": "too thin",
  "duplicate-lexical": "duplicate (lexical)",
  "duplicate-semantic": "duplicate (semantic)",
  "duplicate-llm": "duplicate (classifier)",
  trivia: "trivia",
  invalid: "invalid",
  unknown: "unclassified",
};

/** The title written for a `secret-detected` receipt — the candidate's own title is withheld. */
export const REDACTED_TITLE = "(redacted — the candidate carried a credential)";

/**
 * Build the {@link DropClassification} for a category. This is the one table that turns "we dropped
 * something" into "here is why, and here is what to do" — every gate routes through it, so the two
 * user-facing sentences per drop path live in exactly one place.
 */
export function dropFor(category: DropCategory, ctx: DropContext = {}): DropClassification {
  const target = ctx.duplicateOf ?? "an existing note";
  const detail = ctx.detail ? ` (${ctx.detail})` : "";
  switch (category) {
    case "secret-detected":
      return {
        category,
        recoverable: true,
        cause: "The candidate carried something the secret scanner reads as a live credential.",
        nextAction:
          'Describe the secret rather than quoting it ("the key lives in 1Password under X"), then re-record the note with `/commonwealth:remember`.',
      };
    case "autoadr-vetoed":
      return {
        category,
        recoverable: true,
        cause: "A decision candidate was vetoed because this brain has `autoAdr` turned off.",
        nextAction:
          'Set `"features": { "autoAdr": true }` in the brain\'s `.commonwealth/config.json` to capture decisions automatically, or record this one by hand with `/commonwealth:decide`.',
      };
    case "too-thin":
      return {
        category,
        recoverable: true,
        cause: "The candidate had an empty title, or a body under the relevance floor.",
        nextAction: "Re-record it with a fuller body via `/commonwealth:remember`.",
      };
    case "duplicate-lexical":
      return {
        category,
        recoverable: false,
        cause: `The brain already holds this fact almost word-for-word (${target}).`,
        nextAction: null,
      };
    case "duplicate-semantic":
      return {
        category,
        recoverable: false,
        cause: `The brain already holds this fact in different words (${target}).`,
        nextAction: null,
      };
    case "duplicate-llm":
      return {
        category,
        recoverable: false,
        cause: `The curation classifier judged this a restatement of ${target}.`,
        nextAction: null,
      };
    case "trivia":
      return {
        category,
        recoverable: false,
        cause:
          "The durability judge classified this as ephemera a teammate would not want in three months.",
        nextAction:
          "Nothing, normally — but if it really was durable, record it deliberately with `/commonwealth:remember`.",
      };
    case "invalid":
      return {
        category,
        recoverable: false,
        cause: `The candidate failed note validation and was dropped on its own${detail}.`,
        nextAction:
          "This is a bug in the extractor or the schema — report it at https://github.com/kristoffeys/commonwealth/issues with the reason above.",
      };
    case "unknown":
      return {
        category,
        recoverable: false,
        cause: `A curator declined the candidate with a reason this version has no category for${detail}.`,
        nextAction:
          "Give the gate its own `DropCategory` (ADR-0037) so the drop stops being opaque.",
      };
  }
}

/**
 * Classify a free-text curator `reason` (the ADR-0007 pluggable seam returns one) into a
 * {@link DropClassification}. Gates that know their own category call {@link dropFor} directly;
 * this is the fallback for reasons that arrive as strings. An unrecognized reason maps to `unknown`
 * rather than being dropped from the tally — an unclassified drop is still a LOUD drop.
 */
export function classifyDrop(reason: string, duplicateOf?: string): DropClassification {
  const ctx: DropContext = duplicateOf !== undefined ? { duplicateOf } : {};
  switch (reason) {
    case "contains-secret":
      return dropFor("secret-detected", ctx);
    case "auto-adr-disabled":
      return dropFor("autoadr-vetoed", ctx);
    case "too-thin":
      return dropFor("too-thin", ctx);
    case "duplicate":
      return dropFor("duplicate-lexical", ctx);
    case "llm-duplicate":
      return dropFor("duplicate-llm", ctx);
    case "llm-trivia":
      return dropFor("trivia", ctx);
    default:
      return reason.startsWith("invalid:")
        ? dropFor("invalid", { ...ctx, detail: reason.slice("invalid:".length).trim() })
        : dropFor("unknown", { ...ctx, detail: reason });
  }
}

/** One persisted drop: the classification, plus when it happened and what was dropped. */
export interface CaptureReceipt extends DropClassification {
  /** Epoch ms the candidate was dropped. */
  ts: number;
  /** Absolute brain directory the drop happened against (echoed for multi-brain readers). */
  brain: string;
  /**
   * The candidate's title, for a human scanning the tail — REDACTED to {@link REDACTED_TITLE} for
   * `secret-detected`, because the scanner matches the whole candidate and a title is as good a
   * hiding place as a body. A receipt must never be the thing that persists the credential the
   * gate just refused.
   */
  title: string;
  /** The candidate's note kind. */
  kind: string;
  /** Id of the note a duplicate restates, when the category is one of the duplicate classes. */
  duplicateOf?: string;
  /** The raw curator reason string, kept verbatim so the audit trail survives a re-categorization. */
  reason: string;
}

/**
 * The candidate-shaped half of a receipt: what a gate hands over to mint one. Deliberately NOT the
 * candidate itself — a receipt records that a fact was dropped and why, never the fact.
 */
export interface DroppedCandidate {
  title: string;
  kind: string;
  /** The raw curator reason string. */
  reason: string;
  duplicateOf?: string;
  drop: DropClassification;
}

/**
 * Mint a {@link CaptureReceipt} for one dropped candidate.
 *
 * The title is the only candidate text a receipt ever persists, and it is withheld whenever it
 * could carry a credential. That check is the SCANNER, not the drop category: keying redaction on
 * `secret-detected` alone would only cover candidates that actually reached the secret gate, and
 * the ADR-0030 classifier drops (`trivia` / `llm-duplicate`) are rejected in `captureCandidates`
 * BEFORE `curate()` scans anything — so a credential in one of those titles would have been written
 * to disk in the clear by the very mechanism that exists to report on the gate. Scanning here
 * covers every drop path, present and future, and costs one regex sweep over a title.
 */
export function receiptFor(
  brainDir: string,
  dropped: DroppedCandidate,
  ts: number,
): CaptureReceipt {
  const { drop, title, kind, reason, duplicateOf } = dropped;
  const unsafe = drop.category === "secret-detected" || hasSecrets(title);
  return {
    ...drop,
    ts,
    brain: path.resolve(brainDir),
    title: unsafe ? REDACTED_TITLE : title,
    kind,
    reason,
    ...(duplicateOf !== undefined ? { duplicateOf } : {}),
  };
}

/** How many receipts the rolling window keeps. */
export const RECEIPT_WINDOW = 200;

/**
 * Line count at which a write trims back to {@link RECEIPT_WINDOW}. Hysteresis, so the common
 * append does no read-rewrite at all; the log therefore never exceeds this between writes.
 */
export const RECEIPT_HIGH_WATER = 400;

/**
 * Absolute path to a brain's receipt log: `index/receipts.jsonl`. `index/` is gitignored in every
 * scaffolded brain (ADR-0003), so receipts are structurally incapable of being committed or synced.
 */
export function receiptsPath(brainDir: string): string {
  return path.join(brainDir, "index", "receipts.jsonl");
}

/** Read a brain's receipts, oldest first. Never throws; skips corrupt lines rather than the tail. */
export async function readReceipts(brainDir: string): Promise<CaptureReceipt[]> {
  let raw: string;
  try {
    raw = await fs.readFile(receiptsPath(brainDir), "utf8");
  } catch {
    return [];
  }
  const receipts: CaptureReceipt[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as CaptureReceipt;
      if (parsed && typeof parsed === "object" && typeof parsed.category === "string") {
        receipts.push(parsed);
      }
    } catch {
      // Skip a torn/corrupt line rather than losing every receipt after it.
    }
  }
  return receipts;
}

/**
 * Trim the log back to the rolling window. Read-then-atomic-replace, so a reader never sees a
 * half-written file. Two workers trimming at once can lose a handful of receipts to the last
 * rename — acceptable and deliberate: receipts are disposable diagnostics, and paying for a lock
 * (or a fsync) on the capture path would be the wrong trade. Appends themselves are NOT racy.
 */
async function trim(file: string): Promise<void> {
  const lines = (await fs.readFile(file, "utf8")).split("\n").filter((l) => l.trim().length > 0);
  if (lines.length <= RECEIPT_HIGH_WATER) return;
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${lines.slice(-RECEIPT_WINDOW).join("\n")}\n`, "utf8");
  await fs.rename(tmp, file);
}

/**
 * Append receipts to a brain's log, then bound its growth.
 *
 * Concurrency (ADR-0003 — design it out, don't resolve it): every session's capture worker writes
 * the same file, so this uses a SINGLE `O_APPEND` write for the whole batch. POSIX makes that
 * atomic with respect to other appenders — concurrent workers interleave whole batches, never
 * bytes, so no reader ever sees a torn line and no worker's receipts clobber another's. There is no
 * read-modify-write on the append path and therefore nothing to merge.
 *
 * Best-effort by design: a receipt is a diagnostic, so an IO failure is swallowed rather than
 * allowed to fail a capture. Losing a receipt is a worse day; losing a note is a worse product.
 */
export async function appendReceipts(brainDir: string, receipts: CaptureReceipt[]): Promise<void> {
  if (receipts.length === 0) return;
  const file = receiptsPath(brainDir);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, receipts.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");
    await trim(file);
  } catch {
    // Non-fatal: a missing receipt only costs a thinner `doctor` report.
  }
}

/** One category's tally within a {@link DropSummary}. */
export interface DropSummaryEntry {
  category: DropCategory;
  count: number;
  /** Mirrors {@link DropClassification.recoverable} for the category. */
  recoverable: boolean;
  /** The next action for this category, or null when the drop is the correct outcome. */
  nextAction: string | null;
}

/** The aggregate view — the point of receipts: counts per class, not N unrelated strings. */
export interface DropSummary {
  /** Total receipts in the window. */
  total: number;
  /** Of `total`, how many are recoverable (i.e. worth nagging about). */
  recoverable: number;
  /** Per-category tallies, most frequent first (ties broken alphabetically by category). */
  byCategory: DropSummaryEntry[];
  /** Epoch ms of the newest receipt, or null when there are none. */
  newestTs: number | null;
}

/** Options for {@link summarizeDrops}. */
export interface SummarizeOptions {
  /**
   * Ignore receipts older than this epoch-ms. Reporting surfaces MUST pass one: a receipt is a
   * record of something that happened once, and a drop from three months ago says nothing about
   * how the brain is configured today (see {@link RECEIPT_REPORT_WINDOW_DAYS}).
   */
  since?: number;
}

/**
 * How far back the reporting surfaces look. Matches the capture-coverage short window so `doctor`
 * and `status` describe the same recent period, and — crucially — so a warning about a
 * configuration ages out on its own instead of nagging forever after the user fixed it.
 */
export const RECEIPT_REPORT_WINDOW_DAYS = 7;

/** Aggregate receipts into a {@link DropSummary}. Pure; safe on an empty list. */
export function summarizeDrops(
  receipts: CaptureReceipt[],
  opts: SummarizeOptions = {},
): DropSummary {
  const counts = new Map<DropCategory, DropSummaryEntry>();
  let recoverable = 0;
  let newestTs: number | null = null;
  let total = 0;
  for (const r of receipts) {
    if (typeof opts.since === "number" && !(typeof r.ts === "number" && r.ts >= opts.since)) {
      continue;
    }
    total += 1;
    const existing = counts.get(r.category);
    if (existing) existing.count += 1;
    else {
      // Take `recoverable`/`nextAction` from the CURRENT table rather than from the persisted
      // receipt: a receipt written by an older version carries that version's wording, and the
      // advice we print must be the advice this version actually stands behind.
      const current = dropFor(r.category);
      counts.set(r.category, {
        category: r.category,
        count: 1,
        recoverable: current.recoverable,
        nextAction: current.nextAction,
      });
    }
    if (dropFor(r.category).recoverable) recoverable += 1;
    if (typeof r.ts === "number" && (newestTs === null || r.ts > newestTs)) newestTs = r.ts;
  }
  const byCategory = [...counts.values()].sort((a, b) =>
    b.count !== a.count ? b.count - a.count : a.category < b.category ? -1 : 1,
  );
  return { total, recoverable, byCategory, newestTs };
}

/**
 * Render a summary as one aggregate clause — "3 duplicate (lexical), 2 autoAdr-vetoed, 1
 * secret-blocked". Empty string when nothing was dropped, so callers can skip the line entirely.
 */
export function formatDropSummary(summary: DropSummary): string {
  return summary.byCategory.map((e) => `${e.count} ${DROP_LABELS[e.category]}`).join(", ");
}
