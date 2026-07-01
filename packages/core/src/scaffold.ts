export interface InitBrainOptions {
  /** Human-readable brain name, written into COMMONS.md / .commons/config. */
  name?: string;
  /** Proceed even if the directory already contains files. */
  force?: boolean;
}

/**
 * Initialize a brain repository skeleton at `dir` (see docs/01-architecture.md §1,
 * docs/02-data-model.md). Creates:
 *   - the four kind folders: memory/ decisions/ work-state/ people/
 *   - `.commons/` with `schema-version` and a `config` file (name, remotes, curation)
 *   - `.gitattributes` with `merge=union` for derived/append-only files (ADR-0003)
 *   - `.gitignore` ignoring the derived `index/` and `*.db`
 *   - a generated `COMMONS.md` router and per-folder `INDEX.md` placeholders
 *
 * Idempotent unless `force` is needed to write into a non-empty dir.
 */
export async function initBrain(_dir: string, _opts?: InitBrainOptions): Promise<void> {
  throw new Error("not implemented: initBrain");
}
