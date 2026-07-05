import { promises as fs } from "node:fs";
import path from "node:path";
import { loadBrainConfig, scanOptions } from "./config.js";
import { regenerateDerived } from "./index-db.js";
import { parseNote } from "./notes.js";
import { KIND_DIR, type Note } from "./schema.js";
import { findSecrets } from "./secrets.js";

/**
 * Disaster-recovery proof (#136). "Your knowledge is portable git you own" is Commonwealth's core
 * anti-lock-in claim; today it's an assertion. {@link verifyBrain} turns it into an exit-code gate:
 * given a materialized brain (a fresh clone in CI, or a working copy), it proves full recovery —
 * every note is schema-valid, ids are unique, supersede chains resolve, no secrets leaked into
 * canon, and the derived `COMMONWEALTH.md`/`INDEX.md` regenerate byte-for-byte identically to what
 * is committed. Every primitive already lives in core; this composes them.
 *
 * Pure and deterministic: no git, no clock, no network — the CLI's `verify-restore` wraps this
 * with the `git clone` + RPO reporting. The one side effect is regenerating the derived files in
 * the (throwaway) directory it is pointed at, which is how the byte-identical check is made.
 */

/** One verification dimension: did it pass, and what failed if not. */
export interface VerifyCheck {
  /** Stable machine id: `schema` | `ids` | `supersede` | `secrets` | `derived`. */
  id: string;
  /** Human label. */
  label: string;
  ok: boolean;
  /** One-line human summary of the outcome. */
  detail: string;
  /** Specific offenders (note paths, ids, drifted files) when `ok` is false. */
  offenders?: string[];
}

/** The full recovery proof for a materialized brain. `ok` iff every check passed. */
export interface VerifyResult {
  /** Directory verified. */
  dir: string;
  /** Notes successfully parsed (the recovered canon). */
  noteCount: number;
  checks: VerifyCheck[];
  ok: boolean;
}

/** Top-level dirs that never hold notes/derived files (mirrors notes.ts). */
const NON_NOTE_DIRS = new Set([".git", ".commonwealth", "index", "staging", "node_modules"]);
const KIND_FOLDERS = new Set<string>(Object.values(KIND_DIR));

/** A note file discovered on disk with its raw content (parse deferred so we can report errors). */
interface RawNote {
  /** Path relative to the brain dir. */
  rel: string;
  raw: string;
}

/** Walk the brain for note files (same rule as `listNotes`: parent is a kind folder, not INDEX.md). */
async function collectNoteFiles(brainDir: string): Promise<RawNote[]> {
  const out: RawNote[] = [];
  async function walk(absDir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (NON_NOTE_DIRS.has(entry.name)) continue;
        await walk(path.join(absDir, entry.name));
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".md") &&
        entry.name !== "INDEX.md" &&
        KIND_FOLDERS.has(path.basename(absDir))
      ) {
        const abs = path.join(absDir, entry.name);
        out.push({ rel: path.relative(brainDir, abs), raw: await fs.readFile(abs, "utf8") });
      }
    }
  }
  await walk(brainDir);
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

/** Read the root `COMMONWEALTH.md` and every `INDEX.md` into a rel-path → content map. */
async function collectDerived(brainDir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const root = path.join(brainDir, "COMMONWEALTH.md");
  try {
    map.set("COMMONWEALTH.md", await fs.readFile(root, "utf8"));
  } catch {
    map.set("COMMONWEALTH.md", "");
  }
  async function walk(absDir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (NON_NOTE_DIRS.has(entry.name)) continue;
        await walk(path.join(absDir, entry.name));
      } else if (entry.isFile() && entry.name === "INDEX.md") {
        const abs = path.join(absDir, entry.name);
        map.set(path.relative(brainDir, abs), await fs.readFile(abs, "utf8"));
      }
    }
  }
  await walk(brainDir);
  return map;
}

/** Every id a note references via a supersede relationship (normalizing `[[id]]` wikilinks). */
function supersedeRefs(note: Note): string[] {
  const fm = note.frontmatter;
  const refs: string[] = [];
  if (fm.kind === "decision") refs.push(...fm.supersedes);
  if ((fm.kind === "decision" || fm.kind === "memory") && typeof fm.superseded_by === "string") {
    refs.push(fm.superseded_by);
  }
  return refs.map((r) => r.replace(/^\[\[|\]\]$/g, ""));
}

/**
 * Prove `brainDir` fully recovers. Runs five checks and returns a {@link VerifyResult}; `ok` is
 * true iff all pass. NOTE: the `derived` check regenerates `COMMONWEALTH.md`/`INDEX.md` in place,
 * so point this at a throwaway clone, never a working copy you care about.
 */
export async function verifyBrain(brainDir: string): Promise<VerifyResult> {
  const dir = path.resolve(brainDir);
  const files = await collectNoteFiles(dir);

  // 1) Schema — every note file parses to a valid Note.
  const parsed: Note[] = [];
  const malformed: string[] = [];
  for (const f of files) {
    try {
      parsed.push(parseNote(f.raw, f.rel));
    } catch (err) {
      malformed.push(`${f.rel}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  const checks: VerifyCheck[] = [];
  checks.push({
    id: "schema",
    label: "Schema",
    ok: malformed.length === 0,
    detail:
      malformed.length === 0
        ? `All ${files.length} note file(s) are schema-valid.`
        : `${malformed.length} of ${files.length} note file(s) failed to parse.`,
    ...(malformed.length ? { offenders: malformed } : {}),
  });

  // 2) Unique ids — no two notes share an id (the collision-proof-id invariant, ADR-0003).
  const seen = new Map<string, number>();
  for (const n of parsed) seen.set(n.frontmatter.id, (seen.get(n.frontmatter.id) ?? 0) + 1);
  const dupes = [...seen.entries()].filter(([, c]) => c > 1).map(([id, c]) => `${id} (×${c})`);
  checks.push({
    id: "ids",
    label: "Unique ids",
    ok: dupes.length === 0,
    detail:
      dupes.length === 0
        ? `All ${parsed.length} ids are unique.`
        : `${dupes.length} duplicate id(s).`,
    ...(dupes.length ? { offenders: dupes } : {}),
  });

  // 3) Supersede chains — every referenced id resolves to a note that recovered.
  const ids = new Set(parsed.map((n) => n.frontmatter.id));
  const dangling: string[] = [];
  for (const n of parsed) {
    for (const ref of supersedeRefs(n)) {
      if (!ids.has(ref)) dangling.push(`${n.frontmatter.id} → ${ref} (missing)`);
    }
  }
  checks.push({
    id: "supersede",
    label: "Supersede chains",
    ok: dangling.length === 0,
    detail:
      dangling.length === 0
        ? "All supersede references resolve."
        : `${dangling.length} dangling reference(s).`,
    ...(dangling.length ? { offenders: dangling } : {}),
  });

  // 4) Secrets — no credential leaked into recovered canon (uses the brain's own scan config).
  const opts = scanOptions(await loadBrainConfig(dir));
  const leaked: string[] = [];
  for (const f of files) {
    const hits = findSecrets(f.raw, opts);
    if (hits.length > 0) leaked.push(`${f.rel}: ${hits.map((h) => h.kind).join(", ")}`);
  }
  checks.push({
    id: "secrets",
    label: "Secrets",
    ok: leaked.length === 0,
    detail:
      leaked.length === 0
        ? "No secrets found in canon."
        : `${leaked.length} note(s) contain secrets.`,
    ...(leaked.length ? { offenders: leaked } : {}),
  });

  // 5) Derived byte-identical — regenerating COMMONWEALTH.md/INDEX.md reproduces exactly what is
  //    committed. Drift means the router a teammate reads is stale — a silent recovery defect.
  const before = await collectDerived(dir);
  await regenerateDerived(dir);
  const after = await collectDerived(dir);
  const drifted: string[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if ((before.get(key) ?? "") !== (after.get(key) ?? "")) drifted.push(key);
  }
  drifted.sort();
  checks.push({
    id: "derived",
    label: "Derived files",
    ok: drifted.length === 0,
    detail:
      drifted.length === 0
        ? "COMMONWEALTH.md / INDEX.md regenerate byte-identically."
        : `${drifted.length} derived file(s) drifted from the committed copy.`,
    ...(drifted.length ? { offenders: drifted } : {}),
  });

  return { dir, noteCount: parsed.length, checks, ok: checks.every((c) => c.ok) };
}
