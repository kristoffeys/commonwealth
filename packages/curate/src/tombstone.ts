import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Reject-tombstones for org-brain graduation (#172, follow-up to #110/ADR-0023). When a reviewer
 * rejects a graduation candidate, the recurring-fact cluster is neither canon nor staged, so the
 * next `commonwealth graduate` run would re-detect and re-stage it — the reviewer sees the same
 * rejected candidate again, eroding trust in the queue. A tombstone records the cluster's stable
 * identity so subsequent passes skip it (visibly, with a suppressed count — never silently).
 *
 * The store lives in the ORG-BRAIN and is SHARED + VERSIONED: rejecting a cross-brain candidate is
 * org-level curation state — the whole team should agree "this did not graduate" — so it is a
 * committed file (`<org>/.commonwealth/graduation-tombstones.json`), synced like `config.json`, not
 * per-user local state. It sits under `.commonwealth/`, which {@link verifyBrain} treats as a
 * non-note dir, so it round-trips through derived rebuild / `verify-restore` untouched and survives
 * a fresh clone.
 *
 * Candidate identity reuses graduation's existing similarity keying: the cross-brain clustering
 * (cosine + lexical) decides which origin notes group together, and each surviving cluster records
 * its origins as `graduated_from` (sorted, deduped `<source>/<id>` refs). The tombstone key is a
 * stable hash of that set — so a paraphrase that still clusters together yields the same key, and a
 * materially different cluster (different origins) is unaffected. No new matching scheme is invented.
 */

/** Relative path of the tombstone store within a brain. */
const TOMBSTONE_REL = path.join(".commonwealth", "graduation-tombstones.json");

/** On-disk store version, so a future format change is detectable. */
const STORE_VERSION = 1;

/** One recorded rejection, keyed by {@link graduationClusterKey}. */
export interface GraduationTombstone {
  /** Sorted, deduped `<source>/<id>` origin refs the rejected cluster spanned (audit + re-key). */
  refs: string[];
  /** Title of the rejected candidate, for the human-facing suppressed summary and audit trail. */
  title: string;
  /** Note kind of the rejected candidate. */
  kind: string;
  /** When the rejection was recorded (ISO 8601). */
  rejectedAt: string;
}

/** The full tombstone store: version + entries keyed by cluster key. */
interface TombstoneStore {
  version: number;
  tombstones: Record<string, GraduationTombstone>;
}

/** Absolute path to a brain's graduation-tombstone store. */
export function tombstonePath(brainDir: string): string {
  return path.join(brainDir, TOMBSTONE_REL);
}

/**
 * Stable identity for a graduation cluster: a short SHA-256 over its sorted, deduped origin refs
 * (the `graduated_from` set). Deterministic across machines — the same origin set always hashes to
 * the same key, so a tombstone written on reject matches the cluster recomputed on the next pass.
 */
export function graduationClusterKey(refs: string[]): string {
  const canonical = [...new Set(refs)].sort();
  return createHash("sha256").update(canonical.join("\n")).digest("hex").slice(0, 16);
}

/** Read the tombstone store, tolerating a missing/torn/foreign file by returning an empty store. */
async function readStore(brainDir: string): Promise<TombstoneStore> {
  let raw: string;
  try {
    raw = await fs.readFile(tombstonePath(brainDir), "utf8");
  } catch {
    return { version: STORE_VERSION, tombstones: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { version: STORE_VERSION, tombstones: {} };
  }
  const obj = (
    typeof parsed === "object" && parsed !== null ? parsed : {}
  ) as Partial<TombstoneStore>;
  const tombstones =
    typeof obj.tombstones === "object" && obj.tombstones !== null
      ? (obj.tombstones as Record<string, GraduationTombstone>)
      : {};
  return { version: STORE_VERSION, tombstones };
}

/**
 * Persist the tombstone store as pretty JSON with keys in sorted order (so concurrent teammates who
 * reject different candidates produce line-disjoint diffs that union-merge cleanly, ADR-0003) and a
 * trailing newline. Atomic tmp+rename, mirroring {@link saveBrainConfig}.
 */
async function writeStore(brainDir: string, store: TombstoneStore): Promise<void> {
  const file = tombstonePath(brainDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const ordered: Record<string, GraduationTombstone> = {};
  for (const key of Object.keys(store.tombstones).sort()) ordered[key] = store.tombstones[key]!;
  const out = { version: STORE_VERSION, tombstones: ordered };
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

/** The set of tombstoned cluster keys in a brain (empty when the store is absent). */
export async function loadTombstonedKeys(brainDir: string): Promise<Set<string>> {
  const store = await readStore(brainDir);
  return new Set(Object.keys(store.tombstones));
}

/**
 * Record a rejected graduation cluster. Idempotent: re-rejecting the same cluster overwrites its
 * entry (keeping the latest timestamp) rather than duplicating it. Returns the cluster key written.
 */
export async function addTombstone(
  brainDir: string,
  entry: { refs: string[]; title: string; kind: string },
): Promise<string> {
  const key = graduationClusterKey(entry.refs);
  const store = await readStore(brainDir);
  store.tombstones[key] = {
    refs: [...new Set(entry.refs)].sort(),
    title: entry.title,
    kind: entry.kind,
    rejectedAt: new Date().toISOString(),
  };
  await writeStore(brainDir, store);
  return key;
}
