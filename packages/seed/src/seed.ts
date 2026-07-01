import type { NewNoteInput } from "@commons/core";
import { importConfigs } from "./config-importer.js";
import { mineGitHistory, type MineGitHistoryOptions } from "./git-miner.js";

/** Options for {@link gatherCandidates}. */
export interface GatherOptions extends MineGitHistoryOptions {}

/** Per-source candidate counts, for previews and reporting. */
export interface GatherBySource {
  /** ADR-derived `decision` candidates. */
  adr: number;
  /** Commit / merged-PR `memory` candidates. */
  git: number;
  /** Agent-config `memory` candidates. */
  config: number;
}

/** Result of {@link gatherCandidates}: the full candidate list plus per-source counts. */
export interface GatherResult {
  candidates: NewNoteInput[];
  bySource: GatherBySource;
}

/**
 * Gather all cold-start seed candidates from a repository: ADR decisions and notable git
 * commits (via {@link mineGitHistory}) plus agent-config files (via {@link importConfigs}).
 * This is the umbrella the CLI and wizard call. Deterministic and offline; output order is
 * stable — ADR candidates, then git candidates, then config candidates — so a preview run
 * matches the subsequent apply run.
 *
 * @param repoDir Absolute path to the repository to seed from.
 * @param opts Tuning options; see {@link GatherOptions}.
 * @returns The concatenated candidate list and per-source counts.
 */
export async function gatherCandidates(
  repoDir: string,
  opts?: GatherOptions,
): Promise<GatherResult> {
  const gitCandidates = await mineGitHistory(repoDir, opts);
  const configCandidates = await importConfigs(repoDir);

  // mineGitHistory returns ADR (decision) candidates first, then git (memory) candidates.
  // Split them back out so bySource is accurate and ordering is explicit.
  const adr = gitCandidates.filter((n) => n.kind === "decision");
  const git = gitCandidates.filter((n) => n.kind !== "decision");

  const candidates = [...adr, ...git, ...configCandidates];
  return {
    candidates,
    bySource: {
      adr: adr.length,
      git: git.length,
      config: configCandidates.length,
    },
  };
}
