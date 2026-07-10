import { listNotes } from "./notes.js";
import { NOTE_KINDS, type Note, type NoteKind } from "./schema.js";

/**
 * Brain-map / coverage rollup (#205). The brain's contents are otherwise invisible — the derived
 * index is agent-facing — so a new teammate has no "what does this thing actually hold?" surface.
 * This answers it: how many notes of each kind, and who has contributed. Pure and read-only —
 * computed from the note set (the source of truth), never written back (ADR-0003). Pairs with the
 * decay-focused {@link brainHealth} rollup; the CLI `map` command renders both together.
 */

/** Note count for one of the four kinds. All four kinds are always present (0 if none). */
export interface KindCount {
  kind: NoteKind;
  count: number;
}

/** One contributor and how many notes carry their `author` (ADR-0015 provenance). */
export interface Contributor {
  /** The note `author`, or {@link UNATTRIBUTED} for notes with no author set. */
  author: string;
  count: number;
}

/** The brain-map rollup for a note set. */
export interface BrainMap {
  /** Notes considered. */
  total: number;
  /** Per-kind counts, in canonical {@link NOTE_KINDS} order — coverage is visible even at 0. */
  byKind: KindCount[];
  /** Contributors, most notes first (ties broken by author name). */
  contributors: Contributor[];
}

/** Bucket label for notes with no `author` (pre-existing / non-attributed notes). */
export const UNATTRIBUTED = "(unattributed)";

/**
 * Compute the {@link BrainMap} for `notes`. Every one of the four {@link NOTE_KINDS} appears in
 * `byKind` (count 0 when absent) so coverage gaps are legible, and contributors are ranked by note
 * count then author name. Notes with no `author` are grouped under {@link UNATTRIBUTED}.
 */
export function brainMap(notes: Note[]): BrainMap {
  const kindCounts = new Map<NoteKind, number>(NOTE_KINDS.map((k) => [k, 0]));
  const authorCounts = new Map<string, number>();

  for (const n of notes) {
    const { kind, author } = n.frontmatter;
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
    const who = author && author.trim().length > 0 ? author.trim() : UNATTRIBUTED;
    authorCounts.set(who, (authorCounts.get(who) ?? 0) + 1);
  }

  const byKind: KindCount[] = NOTE_KINDS.map((kind) => ({
    kind,
    count: kindCounts.get(kind) ?? 0,
  }));
  const contributors: Contributor[] = [...authorCounts.entries()]
    .map(([author, count]) => ({ author, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.author < b.author ? -1 : 1));

  return { total: notes.length, byKind, contributors };
}

/** Load a brain's notes and compute its {@link BrainMap}. Read-only; never writes canon. */
export async function computeBrainMap(brainDir: string): Promise<BrainMap> {
  return brainMap(await listNotes(brainDir));
}
