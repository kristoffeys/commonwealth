import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { brainHealth } from "./health.js";
import { planDerived } from "./index-db.js";
import { listNoteFiles, parseNote, resolveWithinBrain } from "./notes.js";
import { KIND_DIR, type Note } from "./schema.js";

/**
 * Vault-hygiene lint (#258). `doctor` diagnoses the install/sync chain and `verify-restore` proves a
 * clone recovers, but nothing reported **link-graph hygiene**: a `superseded_by` pointing at an id
 * that no longer exists, a `[[wikilink]]` to nothing, a note filed under the wrong kind folder, a
 * `COMMONWEALTH.md` that drifted from the notes it derives from. Each rots the brain silently — a
 * teammate follows a chain and lands nowhere, or reads a hub that no longer describes canon.
 *
 * Read-only and pure w.r.t. the files: {@link lintBrain} never writes. The one repair — rebuilding
 * stale derived views — is the CALLER's, gated behind `--fix`, and it *regenerates* rather than
 * patches (ADR-0003: derived files are regenerated, never hand-merged). Canon note bodies are never
 * touched by anything here.
 *
 * Deliberately conservative about what counts as broken, because a lint that cries wolf gets
 * ignored. Cross-brain provenance refs (`<source>/<id>`, written by graduation), URLs, wikilinks
 * inside code spans, and `sources[]` entries that aren't wikilink-shaped are all skipped outright.
 * `error` is reserved for the three defects that put a note (or the truth it points at) out of
 * reach — it doesn't parse, its id doesn't match its filename, or a supersede chain dead-ends;
 * everything else warns or informs, so an exit code stays a gate on breakage, not on housekeeping.
 */

/** How bad a finding is. `error` fails the lint; `warn`/`info` do not. */
export type HygieneSeverity = "error" | "warn" | "info";

/** One hygiene defect, attributed to the file it lives in. */
export interface HygieneFinding {
  /**
   * Stable machine id of the rule that fired: `schema` | `id-path` | `kind-dir` | `dead-supersede` |
   * `supersede-kind` | `dead-link` | `dead-author-ref` | `orphan` | `stale-derived`.
   */
  rule: string;
  severity: HygieneSeverity;
  /** Repo-relative path of the note (or derived file) the finding is about. */
  where: string;
  /** One-line human explanation. */
  message: string;
}

/** The hygiene report for a brain. `ok` iff no `error`-severity finding fired. */
export interface HygieneReport {
  /** Directory linted. */
  dir: string;
  /** Note files discovered on disk (including any that failed to parse). */
  fileCount: number;
  /** Notes that parsed — the link graph was computed over these. */
  noteCount: number;
  findings: HygieneFinding[];
  /**
   * Derived files whose regenerated content differs from what is on disk (or that are missing
   * entirely) — repo-relative, sorted. Regenerable, so the caller may rebuild them; never merged.
   */
  staleDerived: string[];
  /**
   * How many notes nothing links to. ALWAYS computed (it is O(notes) over what is already parsed),
   * independent of {@link HygieneOptions.reportOrphans} — that flag only decides whether each orphan
   * also gets its own `info` finding, so a caller can report the count without paying for the list.
   */
  orphanCount: number;
  /** Findings per severity, for a one-line summary. */
  counts: Record<HygieneSeverity, number>;
  ok: boolean;
}

/** Options for {@link lintBrain}. */
export interface HygieneOptions {
  /**
   * Compare the committed derived views against a fresh regeneration (default true). Set false to
   * skip it — it re-renders the whole hub, which a caller that only wants the link graph needn't pay.
   */
  checkDerived?: boolean;
  /**
   * Emit one `info` finding per orphan note (nothing links to it), default false. Off by default
   * because a standalone memory note is legitimately common: a caller that wants the *count* asks
   * `commonwealth health`, and only a caller that wants to LIST them (the `lint` detail view) pays
   * for a finding each.
   */
  reportOrphans?: boolean;
}

/**
 * Normalize one reference into the bare id (or title) it points at, or `null` when it is not a
 * LOCAL note reference at all and must not be linted.
 *
 * Skipped deliberately:
 * - cross-brain provenance refs (`<source>/<id>`, written by graduation) and any other path-shaped
 *   ref — the target lives in a different brain, so "missing here" is the normal case;
 * - URLs / URI-ish values (`https://…`, `mailto:…`) that legitimately appear in `sources[]`;
 * - empty strings.
 *
 * Wikilink decoration is stripped: `[[id|Label]]` → `id`, and a `#heading` fragment is dropped.
 */
function refTarget(raw: string): string | null {
  let ref = raw.trim();
  if (ref.startsWith("[[") && ref.endsWith("]]")) ref = ref.slice(2, -2).trim();
  const pipe = ref.indexOf("|");
  if (pipe !== -1) ref = ref.slice(0, pipe).trim();
  const hash = ref.indexOf("#");
  if (hash !== -1) ref = ref.slice(0, hash).trim();
  if (ref.length === 0) return null;
  if (ref.includes("/") || ref.includes("\\") || ref.includes(":")) return null;
  return ref;
}

/**
 * Every `[[wikilink]]` in a markdown body, in source order (duplicates collapsed).
 *
 * Code is stripped FIRST, because markdown does not render a link inside it and neither does
 * Obsidian: a note explaining that "links use `[[wikilink]]` syntax" is documenting the syntax, not
 * linking to a note called `wikilink`. Without this, every note that discusses the format reports a
 * dead link — the exact false positive that gets a lint ignored.
 *
 * Both fence forms are matched with any leading indentation or `>` quote markers, because the most
 * common way a note carries an example is a fence nested inside a list item or a blockquote, and an
 * anchored three-backtick-at-column-zero pattern misses exactly those. The closing fence must repeat
 * the opening run, so a four-backtick block wrapping a three-backtick one survives intact. Inline
 * spans allow a backtick run of any length, so a double-backtick span is stripped too.
 *
 * NOT stripped: the 4-space-indented code block form. Under a list item, four-space indentation is
 * ordinary continuation text rather than code, and blinding the lint to all of it would cost more
 * real dead links than the rare indented code block would save in false ones.
 */
export function bodyWikilinks(body: string): string[] {
  const prose = body
    // Fenced blocks (``` or ~~~), indented and/or blockquoted; closing fence repeats the opening run.
    .replace(/^[ \t>]*(`{3,}|~{3,})[\s\S]*?^[ \t>]*\1/gm, "")
    // An unterminated fence runs to the end of the note — strip its tail too, or everything after a
    // trailing example block is linted as prose.
    .replace(/^[ \t>]*(?:`{3,}|~{3,})[\s\S]*$/m, "")
    // Inline code spans, any backtick-run length.
    .replace(/(`+)[^\n]*?\1/g, "");
  const out = new Set<string>();
  for (const m of prose.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    const target = refTarget(m[1]!);
    if (target !== null) out.add(target);
  }
  return [...out];
}

/**
 * A one-line, actionable summary of why a note failed to parse. A `ZodError`'s `message` is a
 * multi-line JSON dump, so naively taking its first line yields the literal string `"["` — which is
 * what a reader of this lint would otherwise be told is wrong with their note. Collapse it to
 * `field: reason` pairs instead.
 */
function parseFailureReason(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues
      .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(frontmatter)"}: ${i.message}`)
      .join("; ");
  }
  return (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "unknown error";
}

/** Kinds that carry a supersede chain — the only legitimate target of `superseded_by`/`supersedes`. */
const SUPERSEDEABLE = new Set(["memory", "decision"]);

/** One reference to lint: where it came from, and what it points at. */
interface Ref {
  /** Frontmatter field or `body`, for the message. */
  field: string;
  target: string;
}

/** Every LOCAL note reference a note makes, by field. Non-local refs are dropped by {@link refTarget}. */
function noteRefs(note: Note): Ref[] {
  const fm = note.frontmatter;
  const refs: Ref[] = [];
  const push = (field: string, values: readonly (string | null | undefined)[]): void => {
    for (const v of values) {
      if (typeof v !== "string") continue;
      const target = refTarget(v);
      if (target !== null) refs.push({ field, target });
    }
  };

  push("relates", fm.relates);
  if (fm.kind === "memory" || fm.kind === "decision") {
    push("superseded_by", [fm.superseded_by]);
    push("contradicts", fm.contradicts ?? []);
  }
  if (fm.kind === "decision") push("supersedes", fm.supersedes);
  // `sources[]` is free-form provenance (URLs, cross-brain `<source>/<id>` refs from graduation), so
  // only an explicitly wikilink-shaped entry is claiming to be a local note reference.
  if (fm.kind === "memory") {
    push(
      "sources",
      fm.sources.filter((s) => s.trim().startsWith("[[")),
    );
  }
  for (const target of bodyWikilinks(note.body)) refs.push({ field: "body", target });
  return refs;
}

/** True when `ref` resolves to a note by id, or (leniently, for prose links) by exact title. */
function resolves(ref: string, byId: Map<string, Note>, byTitle: Map<string, Note>): boolean {
  return byId.has(ref) || byTitle.has(ref.toLowerCase());
}

/**
 * Lint the link-graph and derived-view hygiene of `brainDir`. Read-only.
 *
 * Rules, and why each severity:
 * - `schema` (**error**) — a note file that does not parse. `listNotes` skips these with a stderr
 *   line, so they are INVISIBLE to search, the index, and the derived hub: a note that exists on
 *   disk but is not in canon.
 * - `id-path` (**error**) — frontmatter `id` ≠ the filename stem. Every link in the brain addresses
 *   a note by id, so a desynced id is unreachable by wikilink even though the file is there.
 * - `kind-dir` (**warn**) — the note sits in a folder that isn't its kind's. Reads still work
 *   (frontmatter is authoritative and `listNotes` is layout-agnostic), but the vault layout lies.
 * - `dead-supersede` (**error**) — a supersede reference resolving to nothing. This is the one link
 *   a reader is *told* to follow to find the current truth; broken, it strands them mid-chain.
 *   `verify-restore` already fails on it, so failing here keeps the two gates consistent.
 * - `supersede-kind` (**warn**) — a supersede reference to a kind that carries no chain (a decision
 *   that `supersedes` an open `work-state` question, which capture does emit). The target exists and
 *   the intent reads fine; only the reciprocal `status`/`superseded_by` marking can never be written
 *   on it, so the relationship is half-recorded rather than broken. Not an error: nobody is
 *   stranded, and erroring would fail `doctor` on a state the capture pipeline produces itself.
 * - `dead-link` (**warn**) — a `relates`/`contradicts`/wikilinked-`sources`/body wikilink to an
 *   unknown target. Informative rather than fatal: prose links to not-yet-written notes are a
 *   normal way to work (and are how `[[name]]` marks a gap).
 * - `dead-author-ref` (**warn**) — `author_ref` pointing at a missing note or a non-`person` note.
 * - `orphan` (**info**, opt-in) — nothing links to the note. Legitimately common for standalone
 *   facts, so it is never an error and is only reported when `reportOrphans` is set.
 * - `stale-derived` (**warn**) — a derived view drifted from the notes. Regenerable, so it is a
 *   warning plus a rebuild, never a merge.
 */
export async function lintBrain(
  brainDir: string,
  opts: HygieneOptions = {},
): Promise<HygieneReport> {
  const dir = path.resolve(brainDir);
  // Fail loud on a brain that isn't there. Every primitive below tolerates a missing directory (an
  // unreadable dir lists zero notes), so without this the lint would report a confident "0 notes,
  // link graph intact, COMMONWEALTH.md has drifted" about a path that does not exist — a clean bill
  // of health for a brain that was never cloned, or a typo'd registry entry.
  const stat = await fs.stat(dir).catch(() => null);
  if (stat === null || !stat.isDirectory()) {
    throw new Error(`Not a brain directory: ${dir}`);
  }

  const files = await listNoteFiles(dir);

  const notes: Note[] = [];
  const findings: HygieneFinding[] = [];

  for (const rel of files) {
    let note: Note;
    try {
      note = parseNote(await fs.readFile(resolveWithinBrain(dir, rel), "utf8"), rel);
    } catch (err) {
      findings.push({
        rule: "schema",
        severity: "error",
        where: rel,
        message: `does not parse, so it is invisible to search and the derived views — ${parseFailureReason(err)}`,
      });
      continue;
    }
    notes.push(note);

    const segments = rel.split(/[\\/]/);
    const stem = segments[segments.length - 1]!.replace(/\.md$/, "");
    const parent = segments.length >= 2 ? segments[segments.length - 2]! : "";
    if (stem !== note.frontmatter.id) {
      findings.push({
        rule: "id-path",
        severity: "error",
        where: rel,
        message: `frontmatter id \`${note.frontmatter.id}\` does not match the filename stem \`${stem}\` — wikilinks to either one cannot resolve`,
      });
    }
    const expected = KIND_DIR[note.frontmatter.kind];
    if (parent !== expected) {
      findings.push({
        rule: "kind-dir",
        severity: "warn",
        where: rel,
        message: `is kind \`${note.frontmatter.kind}\` but sits in \`${parent}/\` instead of \`${expected}/\``,
      });
    }
  }

  const byId = new Map<string, Note>(notes.map((n) => [n.frontmatter.id, n]));
  const byTitle = new Map<string, Note>(notes.map((n) => [n.frontmatter.title.toLowerCase(), n]));

  for (const note of notes) {
    for (const { field, target } of noteRefs(note)) {
      const isSupersede = field === "superseded_by" || field === "supersedes";
      const hit = byId.get(target);
      if (isSupersede) {
        // Supersede targets address a note by id only — a title match would be a guess about the
        // one link whose whole job is to be unambiguous.
        if (!hit) {
          findings.push({
            rule: "dead-supersede",
            severity: "error",
            where: note.path,
            message: `${field}: \`${target}\` — no note with that id, so the supersede chain dead-ends`,
          });
        } else if (!SUPERSEDEABLE.has(hit.frontmatter.kind)) {
          findings.push({
            rule: "supersede-kind",
            severity: "warn",
            where: note.path,
            message: `${field}: \`${target}\` is a \`${hit.frontmatter.kind}\` note, which carries no supersede chain — the reciprocal \`status\`/\`superseded_by\` can never be written on it`,
          });
        }
        continue;
      }
      if (!resolves(target, byId, byTitle)) {
        findings.push({
          rule: "dead-link",
          severity: "warn",
          where: note.path,
          message: `${field}: \`${target}\` resolves to no note in this brain`,
        });
      }
    }

    const authorRef = note.frontmatter.author_ref;
    if (typeof authorRef === "string" && authorRef.length > 0) {
      const hit = byId.get(authorRef);
      if (!hit) {
        findings.push({
          rule: "dead-author-ref",
          severity: "warn",
          where: note.path,
          message: `author_ref: \`${authorRef}\` — no contributor note with that id`,
        });
      } else if (hit.frontmatter.kind !== "person") {
        findings.push({
          rule: "dead-author-ref",
          severity: "warn",
          where: note.path,
          message: `author_ref: \`${authorRef}\` is a \`${hit.frontmatter.kind}\` note, not a \`person\``,
        });
      }
    }
  }

  // Reuse `brainHealth`'s orphan definition (no inbound reference from any other note) so the lint
  // and `commonwealth health` can never disagree about what an orphan is. Note the deliberate
  // asymmetry with the dead-link rules above: those resolve body wikilinks, `brainHealth` walks
  // FRONTMATTER refs only. So a note reached solely by a `[[Title]]` link in someone's prose counts
  // as an orphan here while its inbound link is not reported dead. Aligning with `health` is the
  // lesser evil — two commands reporting different orphan counts for the same brain is the more
  // confusing failure, and `relates` is the field that is actually meant to carry the graph.
  const orphanIds = new Set(brainHealth(notes).orphaned.ids);
  if (opts.reportOrphans) {
    // Iterate NOTES, not ids: duplicate ids across two files would otherwise both resolve through
    // `byId` to whichever file won the map, naming one path twice and never naming the other.
    for (const note of notes) {
      if (!orphanIds.has(note.frontmatter.id)) continue;
      findings.push({
        rule: "orphan",
        severity: "info",
        where: note.path,
        message: `nothing links to \`${note.frontmatter.id}\` — reachable only through the derived views and search`,
      });
    }
  }

  const staleDerived: string[] = [];
  if (opts.checkDerived !== false) {
    for (const [rel, expected] of await planDerived(dir)) {
      let actual: string | null = null;
      try {
        actual = await fs.readFile(path.join(dir, ...rel.split("/")), "utf8");
      } catch {
        actual = null;
      }
      if (actual !== expected) staleDerived.push(rel);
    }
    staleDerived.sort();
    for (const rel of staleDerived) {
      findings.push({
        rule: "stale-derived",
        severity: "warn",
        where: rel,
        message: "drifted from the notes it derives from — regenerate it (never hand-merge)",
      });
    }
  }

  const counts: Record<HygieneSeverity, number> = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;

  return {
    dir,
    fileCount: files.length,
    noteCount: notes.length,
    findings,
    staleDerived,
    orphanCount: orphanIds.size,
    counts,
    ok: counts.error === 0,
  };
}
