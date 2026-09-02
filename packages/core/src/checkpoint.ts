import { createHash, type Hash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { listNoteFiles } from "./notes.js";

/**
 * Quiet-tick checkpoints for the periodic maintenance passes (#273).
 *
 * `consolidate` (ADR-0017) and `graduate` (ADR-0023) are *sweeps*: they re-read canon end to end
 * and — for graduation — resolve an embeddings provider and re-index brains that lack comparable
 * vectors. Run on a schedule over a real brain (~1800 notes) that is mostly quiescent between
 * ticks, almost every run is expensive work for a guaranteed no-op result. The fix is the cheapest
 * possible pre-flight: fingerprint what the pass *reads*, compare it to the fingerprint of the last
 * run that actually **succeeded**, and skip the expensive stage when they match.
 *
 * Two invariants make that safe rather than merely fast:
 *
 * - **Advance only on success.** A pass records its checkpoint after it completes. If it throws,
 *   is interrupted, bails out (`skipped:` — lock held, no embedder), or completes only PARTIALLY
 *   (graduation could not read one of the brains it meant to scan), the checkpoint stays put, so
 *   the *same* window is re-processed on the next tick. Nothing is silently skipped — which is the
 *   whole point: a guard that trades correctness for cheapness is worse than the waste it saves.
 * - **Absent checkpoint ⇒ do the work.** A fresh clone, a wiped `index/`, an unreadable or
 *   future-version file all read as "no checkpoint", which means a full pass. Every failure mode
 *   here fails toward doing the work.
 *
 * WHERE IT LIVES — under `index/`, the derived, disposable, gitignored area (ADR-0003), one file
 * per pass at `index/checkpoints/<pass>.json`. It is never committed, never synced, and never a
 * source of truth: delete the whole directory and the only consequence is one extra full pass.
 * Each pass owning its own file (rather than one shared blob) means `consolidate` recording a
 * checkpoint can never clobber `graduate`'s, and no writer ever does a read-modify-write — the
 * same per-file discipline the graduation tombstones use, for the same reason.
 *
 * The idea of gating a background maintenance tick on a cheap state diff, and of advancing the
 * marker only on success, is borrowed from openhuman's background reflection loop; the fingerprint
 * scheme, storage, and wiring below are our own.
 */

/** The periodic passes that carry a checkpoint. Each gets its own file — never a shared blob. */
export const MAINTENANCE_PASSES = ["consolidate", "graduate"] as const;

/** A periodic maintenance pass with a quiet-tick checkpoint. */
export type MaintenancePass = (typeof MAINTENANCE_PASSES)[number];

/**
 * Fingerprint scheme version, mixed into every digest. Bump it when {@link fingerprintInputs}
 * changes what it hashes: old checkpoints then compare unequal and every pass runs once in full,
 * which is exactly the conservative outcome we want from a scheme change.
 */
const FINGERPRINT_VERSION = "1";

/** One pass's last successful run over a given input state. */
export interface PassCheckpoint {
  /** {@link fingerprintInputs} digest of the input state that run processed. */
  fingerprint: string;
  /** ISO 8601 time the pass last ran in full over this exact input state. */
  ranAt: string;
  /** ISO 8601 time we last confirmed the inputs still match (refreshed on every quiet tick). */
  checkedAt: string;
}

/** Absolute path to a brain's checkpoint directory inside the derived index area. */
export function checkpointDir(brainDir: string): string {
  return path.join(brainDir, "index", "checkpoints");
}

/** Absolute path to one pass's checkpoint file. */
export function checkpointPath(brainDir: string, pass: MaintenancePass): string {
  return path.join(checkpointDir(brainDir), `${pass}.json`);
}

/** What a pass reads — everything that can change its outcome, and nothing that cannot. */
export interface PassInputs {
  /**
   * Note trees the pass reads, as absolute directories. Each is walked with {@link listNoteFiles},
   * so DERIVED artifacts (`COMMONWEALTH.md`, per-project MOCs, `index/`) are excluded by
   * construction — critical, since those are regenerated on every sync and would otherwise make
   * the fingerprint differ on every tick and defeat the whole guard.
   */
  trees: string[];
  /**
   * Extra directories whose *entry names* matter but whose contents do not — the graduation
   * tombstone store, where each file is written once and never mutated (so the name set is a
   * complete description of the state).
   */
  dirs?: string[];
  /**
   * Individual non-note files the pass's outcome depends on — a brain's `.commonwealth/config.json`,
   * whose feature flags and embeddings settings change what a pass does without touching a single
   * note. Hashed by size + mtime like a note file; absent files hash as absent.
   */
  files?: string[];
  /**
   * Pass parameters that change the outcome (similarity threshold, `includeRejected`, …). Folded
   * into the digest so re-running with a different threshold is never mistaken for a quiet tick.
   */
  params?: Record<string, unknown>;
}

/** Hash one note tree: every note file's relative path, byte size, and mtime. */
async function hashNoteTree(h: Hash, root: string): Promise<void> {
  h.update(`tree\0${root}\n`);
  // Sorted, and no note bodies are read or frontmatter parsed — O(files) readdir + stat only.
  for (const rel of await listNoteFiles(root)) {
    try {
      const st = await fs.stat(path.join(root, rel));
      h.update(`${rel}\0${st.size}\0${st.mtimeMs}\n`);
    } catch {
      // Raced with a delete between the walk and the stat: omit it, exactly as a real deletion
      // would. The omission changes the digest, so the next tick still runs the pass.
    }
  }
}

/** Hash one individual file by its size + mtime; an absent file hashes distinctly from any size. */
async function hashFile(h: Hash, file: string): Promise<void> {
  h.update(`file\0${file}\n`);
  try {
    const st = await fs.stat(file);
    h.update(`${st.size}\0${st.mtimeMs}\n`);
  } catch {
    h.update("absent\n");
  }
}

/** Hash one opaque directory by its sorted entry names (contents deliberately not read). */
async function hashDirNames(h: Hash, dir: string): Promise<void> {
  h.update(`dir\0${dir}\n`);
  try {
    for (const name of (await fs.readdir(dir)).sort()) h.update(`${name}\n`);
  } catch {
    // Absent directory hashes as empty — the same digest a brain with no tombstones yields.
  }
}

/**
 * A cheap fingerprint of everything a pass reads. Per note file it mixes in the relative path, the
 * byte size, and the mtime — O(files) `readdir` + `stat` calls, zero content reads. This is the
 * same signal the reconcile-on-read staleness check uses (#234), tightened from that check's
 * `{count, maxMtime}` rollup to a per-file digest, which costs the same I/O and additionally
 * catches equal-count, equal-max-mtime rearrangements.
 *
 * WHAT IT DETECTS: notes added, notes removed, notes renamed or moved between kind/project folders,
 * and in-place edits (which change mtime, and usually size too).
 *
 * WHAT IT CANNOT DETECT — the honest blind spot: an in-place edit that preserves BOTH the byte
 * length and the mtime. Editors, `git`, and this codebase's own writers never produce that shape
 * (every writer here goes through tmp+rename, which stamps a fresh mtime); only tooling that
 * deliberately restores timestamps (`touch -r`, some archive extractors, a few rsync modes) does.
 * Such an edit is invisible until the next unrelated change to the tree makes the pass run again.
 * It also does not look at note *content*, so it cannot tell a semantically meaningless edit from
 * a meaningful one — it errs toward running the pass, which is the safe direction.
 *
 * Note trees are the only thing walked implicitly. Anything else that can change a pass's
 * outcome — a brain's `.commonwealth/config.json` feature flags, a tombstone store — must be
 * listed explicitly in `dirs`/`files`, or a change to it will be wrongly read as a quiet tick.
 */
export async function fingerprintInputs(inputs: PassInputs): Promise<string> {
  const h = createHash("sha256");
  h.update(`v${FINGERPRINT_VERSION}\n`);
  // Stable key order so a params object built in a different order still matches.
  const params = inputs.params ?? {};
  h.update(`params\0${JSON.stringify(params, Object.keys(params).sort())}\n`);
  // Resolve + sort so the caller's argument order cannot change the digest.
  for (const root of [...new Set(inputs.trees.map((d) => path.resolve(d)))].sort()) {
    await hashNoteTree(h, root);
  }
  for (const dir of [...new Set((inputs.dirs ?? []).map((d) => path.resolve(d)))].sort()) {
    await hashDirNames(h, dir);
  }
  for (const file of [...new Set((inputs.files ?? []).map((f) => path.resolve(f)))].sort()) {
    await hashFile(h, file);
  }
  return h.digest("hex");
}

/**
 * Read one pass's checkpoint, or `null` when there isn't a usable one. Absent, unreadable, or
 * malformed all collapse to `null` ⇒ the caller runs the full pass (fail toward doing the work).
 */
export async function readCheckpoint(
  brainDir: string,
  pass: MaintenancePass,
): Promise<PassCheckpoint | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(checkpointPath(brainDir, pass), "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const c = parsed as Partial<PassCheckpoint>;
    if (typeof c.fingerprint !== "string" || c.fingerprint.length === 0) return null;
    // `ranAt` must be non-empty too: callers report a quiet tick as "unchanged since <ranAt>", and
    // an empty string is falsy, so a blank one would silently downgrade that message to the
    // ordinary "did the work" line. Treat it as no checkpoint ⇒ do the work.
    if (typeof c.ranAt !== "string" || c.ranAt.length === 0) return null;
    if (typeof c.checkedAt !== "string") return null;
    return { fingerprint: c.fingerprint, ranAt: c.ranAt, checkedAt: c.checkedAt };
  } catch {
    return null;
  }
}

/** Write a checkpoint file atomically (tmp + rename), creating the derived dir on demand. */
async function persist(
  brainDir: string,
  pass: MaintenancePass,
  checkpoint: PassCheckpoint,
): Promise<void> {
  const file = checkpointPath(brainDir, pass);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(checkpoint), "utf8");
  await fs.rename(tmp, file);
}

/**
 * Record that `pass` ran to completion over the input state `fingerprint` describes. Call this ONLY
 * on the success path — a pass that threw or bailed must leave the previous checkpoint in place so
 * its window is re-processed.
 *
 * Best-effort: the checkpoint is derived and disposable, so a write failure is swallowed rather
 * than turned into a pass failure. The cost of losing it is one extra full pass.
 */
export async function recordCheckpoint(
  brainDir: string,
  pass: MaintenancePass,
  fingerprint: string,
  now: number,
): Promise<void> {
  const at = new Date(now).toISOString();
  try {
    await persist(brainDir, pass, { fingerprint, ranAt: at, checkedAt: at });
  } catch {
    // Non-fatal — the next tick just re-runs the pass.
  }
}

/**
 * Refresh a checkpoint after a quiet tick: the fingerprint is unchanged, so only `checkedAt`
 * moves. This is what makes a quiet tick genuinely cheap yet observable — the file records that we
 * looked, without claiming the pass re-ran. No-ops when there is no checkpoint to refresh.
 */
export async function confirmCheckpoint(
  brainDir: string,
  pass: MaintenancePass,
  now: number,
): Promise<void> {
  const existing = await readCheckpoint(brainDir, pass);
  if (!existing) return;
  try {
    await persist(brainDir, pass, { ...existing, checkedAt: new Date(now).toISOString() });
  } catch {
    // Non-fatal — see recordCheckpoint.
  }
}

/** The pre-flight verdict for one tick. */
export interface QuietTick {
  /** Digest of the inputs as they are right now. Hand this back to {@link recordCheckpoint}. */
  fingerprint: string;
  /** True when a previous SUCCESSFUL run processed this exact input state ⇒ nothing to do. */
  unchanged: boolean;
  /** ISO 8601 time of that run — only set when `unchanged`, for the "nothing changed" report. */
  since?: string;
}

/**
 * Cheap pre-flight for a periodic pass: fingerprint the inputs and compare against the last
 * successful run. Callers should invoke this INSIDE whatever lock the pass holds, so the
 * fingerprint describes a quiescent tree, and must treat `unchanged` as advisory — an explicit
 * `--force` always wins.
 */
export async function quietTick(
  brainDir: string,
  pass: MaintenancePass,
  inputs: PassInputs,
): Promise<QuietTick> {
  const fingerprint = await fingerprintInputs(inputs);
  const stored = await readCheckpoint(brainDir, pass);
  if (stored && stored.fingerprint === fingerprint) {
    return { fingerprint, unchanged: true, since: stored.ranAt };
  }
  return { fingerprint, unchanged: false };
}
