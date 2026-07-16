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
 * org-level curation state — the whole team should agree "this did not graduate" — so it is
 * committed and synced with the brain, not per-user local state. It sits under `.commonwealth/`,
 * which {@link verifyBrain} treats as a non-note dir, so it round-trips through derived rebuild /
 * `verify-restore` untouched and survives a fresh clone.
 *
 * SHAPE — one tombstone per file, mirroring the codebase's concurrency doctrine (ADR-0003). Each
 * cluster is its own file `graduation-tombstones/<clusterKey>.json`, written once via tmp+rename and
 * NEVER rewritten. That per-file shape is what actually makes cross-writer merges conflict-free:
 * two teammates who reject different clusters on different branches produce an add/add of DISTINCT
 * files, which git merges cleanly — the union-merge guarantee ADR-0003 gives one-fact-per-file
 * atomic notes. A single shared JSON blob would NOT have this property: concurrent edits collide on
 * the same lines (the closing brace, the sorted key list) and cannot be union-merged, because a
 * mechanically merged JSON blob would be syntactically invalid. Because a tombstone file is never
 * mutated after creation, there is also no guarded-writer clobber path (#78) — nothing ever
 * rewrites a file that might have been corrupted underneath us, so a torn file can never destroy a
 * sibling's tombstone.
 *
 * Candidate identity reuses graduation's existing similarity keying: the cross-brain clustering
 * (cosine + lexical) decides which origin notes group together, and each surviving cluster records
 * its origins as `graduated_from` (sorted, deduped `<source>/<id>` refs). The tombstone key is a
 * stable hash of that set — so a paraphrase that still clusters together yields the same key, and a
 * materially different cluster (different origins) is unaffected. No new matching scheme is invented.
 */

/** Relative path of the per-cluster tombstone directory within a brain. */
const TOMBSTONE_DIR_REL = path.join(".commonwealth", "graduation-tombstones");

/** One recorded rejection. Written once as `<clusterKey>.json`; never mutated afterwards. */
export interface GraduationTombstone {
  /** Sorted, deduped `<source>/<id>` origin refs the rejected cluster spanned (audit + re-key). */
  refs: string[];
  /** Title of the rejected candidate, for the audit trail. */
  title: string;
  /** Note kind of the rejected candidate. */
  kind: string;
  /** When the rejection was recorded (ISO 8601). */
  rejectedAt: string;
}

/** Absolute path to a brain's graduation-tombstone directory. */
export function tombstoneDir(brainDir: string): string {
  return path.join(brainDir, TOMBSTONE_DIR_REL);
}

/** Absolute path to a single cluster's tombstone file. */
function tombstoneFile(brainDir: string, key: string): string {
  return path.join(tombstoneDir(brainDir), `${key}.json`);
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

/**
 * The set of tombstoned cluster keys in a brain (empty when the store is absent). The key is the
 * `<key>.json` filename; the file's content is validated so a single torn tombstone is skipped with
 * a breadcrumb rather than trusted blindly. Crucially, one bad file affects only itself — there is
 * no shared blob to take the rest down with it.
 */
export async function loadTombstonedKeys(brainDir: string): Promise<Set<string>> {
  const dir = tombstoneDir(brainDir);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return new Set();
  }
  const keys = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const key = entry.name.slice(0, -".json".length);
    const abs = path.join(dir, entry.name);
    let raw: string;
    try {
      raw = await fs.readFile(abs, "utf8");
    } catch {
      continue; // vanished between readdir and read — treat as absent
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !Array.isArray((parsed as { refs?: unknown }).refs)
      ) {
        throw new Error("not a tombstone record (missing refs[])");
      }
    } catch (err) {
      process.stderr.write(
        `[commonwealth-curate] skipping unreadable tombstone ${entry.name}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      continue;
    }
    keys.add(key);
  }
  return keys;
}

/**
 * Record a rejected graduation cluster as its own file. Idempotent and non-destructive: if the
 * cluster is already tombstoned the existing file is left untouched (a re-reject is a no-op), so a
 * tombstone file is only ever created, never rewritten — which is what keeps concurrent writers
 * conflict-free and sidesteps the guarded-writer clobber risk entirely (#78). Returns the key.
 */
export async function addTombstone(
  brainDir: string,
  entry: { refs: string[]; title: string; kind: string },
): Promise<string> {
  const key = graduationClusterKey(entry.refs);
  const file = tombstoneFile(brainDir, key);
  try {
    await fs.access(file);
    return key; // already tombstoned — never rewrite
  } catch {
    // not present — create it below
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const record: GraduationTombstone = {
    refs: [...new Set(entry.refs)].sort(),
    title: entry.title,
    kind: entry.kind,
    rejectedAt: new Date().toISOString(),
  };
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
  return key;
}
