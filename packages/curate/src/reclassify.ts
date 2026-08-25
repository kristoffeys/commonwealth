import { listNotes, type Note } from "@cmnwlth/core";
import { captureCandidates, type CaptureResult } from "./capture.js";
import type { AnnotatedCandidate } from "./verdict.js";

/**
 * Reclassification pass (#265): promote decision-shaped `memory` notes into real `decision` notes.
 *
 * Cold-start seeding (`@cmnwlth/seed`) maps EVERY git commit to `memory` and only `docs/adr/*` to
 * `decision`, so a brain seeded from repos without an ADR convention — or one that ran with
 * `autoAdr` off — accumulates genuine team decisions ("adopt X", "standardize on Y") filed as
 * memory. This pass re-judges existing memory notes and, for the ones that are really decisions,
 * proposes a `decision` note that SUPERSEDES the source memory (create/supersede, never delete).
 *
 * Doctrine (ADR-0030): the LLM stays OUT of this package. The kind judgment is an injected
 * {@link ReclassifyJudge} — the plugin hook layer supplies the real host-model implementation; tests
 * inject a deterministic mock. Everything here is offline: list → build supersede candidates →
 * hand to {@link captureCandidates}, which applies the existing secret / autoAdr / dedup gate and
 * (with autoPromote on) promotes the decision and marks the source memory superseded.
 */

/** One note handed to the judge — DATA only (id/title/body), never provenance or frontmatter. */
export interface ReclassifyInput {
  id: string;
  title: string;
  body: string;
}

/**
 * The judge's verdict for one memory note. `isDecision` is the gate; when true, `title`/`body` are
 * the decision-framed rewrite (falling back to the source note's own title/body when omitted).
 * Fail-CLOSED: an absent or unreadable judgment must be treated as `isDecision: false` by the judge,
 * so a model/transport glitch never silently rewrites a memory note into a decision.
 */
export interface ReclassifyJudgment {
  isDecision: boolean;
  title?: string;
  body?: string;
  reason?: string;
}

/**
 * Judge a batch of memory notes. Returns a map keyed by note `id` (a missing entry ⇒ keep as
 * memory). Injected so `@cmnwlth/curate` never imports a host model; the caller owns fail-open.
 */
export type ReclassifyJudge = (notes: ReclassifyInput[]) => Promise<Map<string, ReclassifyJudgment>>;

/** One planned reclassification: the source memory note and the decision it would become. */
export interface ReclassifyEntry {
  /** Id of the source memory note (the supersede target). */
  sourceId: string;
  /** Repo-relative path of the source memory note. */
  sourcePath: string;
  /** Git-identity source of the note, carried onto the decision so per-project layout is preserved. */
  source?: string;
  /** Declared project id, carried through unchanged. */
  project?: string;
  /** The source note's original memory title (for the dry-run diff). */
  originalTitle: string;
  /** Decision-framed title for the new note. */
  decisionTitle: string;
  /** Decision-framed body for the new note. */
  decisionBody: string;
  /** The judge's one-line rationale, threaded into the supersede verdict for auditability. */
  reason?: string;
}

export interface ReclassifyPlan {
  /** How many active memory notes were considered (post project/limit filtering). */
  scanned: number;
  /** The notes judged to be decisions, each with its proposed decision + supersede target. */
  candidates: ReclassifyEntry[];
}

export interface ReclassifyOptions {
  /** Restrict to memory notes whose git-identity `source` equals this value (per-project scope). */
  project?: string;
  /** Cap how many memory notes are judged (deterministic prefix of the listing order). */
  limit?: number;
}

/**
 * Read active memory notes and ask the injected judge which are really decisions. Read-only: builds
 * the plan without writing anything. Only `status: "active"` memory is considered — a note already
 * `superseded`/`stale` is left alone so the pass is idempotent (a decision minted on a prior run
 * superseded its source, which is then skipped here).
 */
export async function planReclassify(
  brainDir: string,
  judge: ReclassifyJudge,
  opts: ReclassifyOptions = {},
): Promise<ReclassifyPlan> {
  let memory: Note[] = (await listNotes(brainDir, "memory")).filter(
    (n) => n.frontmatter.status === "active",
  );
  if (opts.project) memory = memory.filter((n) => n.frontmatter.source === opts.project);
  if (typeof opts.limit === "number" && opts.limit >= 0) memory = memory.slice(0, opts.limit);

  if (memory.length === 0) return { scanned: 0, candidates: [] };

  const judged = await judge(
    memory.map((n) => ({ id: n.frontmatter.id, title: n.frontmatter.title, body: n.body })),
  );

  const candidates: ReclassifyEntry[] = [];
  for (const n of memory) {
    const verdict = judged.get(n.frontmatter.id);
    if (!verdict || verdict.isDecision !== true) continue;
    const decisionTitle = verdict.title?.trim() || n.frontmatter.title;
    const decisionBody = verdict.body?.trim() || n.body;
    candidates.push({
      sourceId: n.frontmatter.id,
      sourcePath: n.path,
      ...(n.frontmatter.source ? { source: n.frontmatter.source } : {}),
      ...(n.frontmatter.project ? { project: n.frontmatter.project } : {}),
      originalTitle: n.frontmatter.title,
      decisionTitle,
      decisionBody,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
    });
  }
  return { scanned: memory.length, candidates };
}

/**
 * Apply a plan: for each entry, propose a `decision` note that SUPERSEDES its source memory note,
 * then run the batch through {@link captureCandidates}. This reuses the whole capture machinery —
 * secret gate, the `autoAdr` gate (decisions only land when the brain opted in), lexical/semantic
 * dedup (which collapses N near-identical "adopt X" memories into ONE decision), auto-promotion, and
 * the supersede write (`status` + `superseded_by`) on the source.
 *
 * The supersede target is the source note's own id, injected as the candidate's sole `neighborId` so
 * it clears the ADR-0030 target clamp. Never destructive — nothing is deleted.
 *
 * Two caveats, both benign in practice because the judge REFRAMES each hit into decision language:
 * (1) the decision candidate is still subject to `curate`'s lexical dedup — a decision whose text is
 * near-identical to its source memory would be rejected as a duplicate of that source and the
 * supersede would not fire, so the judge must produce a distinct decision framing (it does). (2) When
 * several sources describe the SAME choice, each still yields its own decision (they supersede their
 * own sources); collapsing those near-duplicate decisions into one is left to `consolidateCanon`
 * (ADR-0017), keeping this pass single-purpose rather than re-implementing clustering.
 */
export async function applyReclassify(
  brainDir: string,
  plan: ReclassifyPlan,
): Promise<CaptureResult> {
  const candidates: AnnotatedCandidate[] = plan.candidates.map((e) => ({
    kind: "decision",
    title: e.decisionTitle,
    body: e.decisionBody,
    tags: ["reclassified"],
    ...(e.source ? { source: e.source } : {}),
    ...(e.project ? { project: e.project } : {}),
    neighborIds: [e.sourceId],
    verdict: {
      judge: "durable",
      consolidation: "supersedes",
      targetId: e.sourceId,
      reason: e.reason ?? "reclassified from memory to decision (#265)",
    },
  }));
  return captureCandidates(brainDir, candidates);
}

/**
 * Convenience: plan, and (when `apply`) apply. Returns the plan always and the capture result only
 * when applied — so a caller can render a dry-run report from `plan` and act on `result` after.
 */
export async function reclassify(
  brainDir: string,
  judge: ReclassifyJudge,
  opts: ReclassifyOptions & { apply?: boolean } = {},
): Promise<{ plan: ReclassifyPlan; result: CaptureResult | null }> {
  const plan = await planReclassify(brainDir, judge, opts);
  if (!opts.apply || plan.candidates.length === 0) return { plan, result: null };
  const result = await applyReclassify(brainDir, plan);
  return { plan, result };
}
