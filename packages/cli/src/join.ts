import path from "node:path";
import { parseArgs } from "node:util";
import {
  addRule,
  defaultBrainsDir,
  ensureBrainCloned,
  importSharedRules,
  loadProjectAliasMap,
  loadRegistryFile,
  mergePeople,
  regenerateDerived,
  resolveBrainDir,
  ruleMatcherKey,
  slugFromRemote,
  type ProjectAliasMap,
} from "@cmnwlth/core";

/** Every git org a brain's project registry lists (owner of `owner/repo` and `owner/*`), lowercased. */
export function registryOrgs(map: ProjectAliasMap): string[] {
  const orgs = Object.values(map).flatMap((e) =>
    e.sources
      .filter((s) => s.indexOf("/") > 0)
      .map((s) => s.slice(0, s.indexOf("/")).toLowerCase()),
  );
  return [...new Set(orgs)].sort();
}

/**
 * `commonwealth join <remote> [--brain <dir>]` (ADR-0047): clone a team brain and route every org
 * its project registry lists to it, so a teammate's sessions in any of those repos capture there.
 * An org that already has a rule keeps it (a local choice wins). Shared rules the brain publishes
 * are imported too. Idempotent: re-running on an existing clone only adds missing routes.
 */
export async function cmdJoin(
  rest: string[],
  opts: { registryPath?: string; log?: (line: string) => void } = {},
): Promise<number> {
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  let values: { brain?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      options: { brain: { type: "string" } },
      allowPositionals: true,
    }));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }
  const remote = positionals[0];
  if (!remote || positionals.length > 1) {
    process.stderr.write("usage: commonwealth join <git-remote> [--brain <dir>]\n");
    return 2;
  }
  const slug = (slugFromRemote(remote) ?? path.basename(remote, ".git")).replace(/\//g, "-");
  const brainDir = path.resolve(values.brain ?? path.join(defaultBrainsDir(), slug));

  const clone = await ensureBrainCloned(brainDir, remote);
  if (clone.status === "failed") {
    process.stderr.write(`could not clone ${remote}: ${clone.error}\n`);
    return 1;
  }
  log(`Brain: ${brainDir} (${clone.status === "cloned" ? "cloned" : "already there"})`);

  const orgs = registryOrgs(await loadProjectAliasMap(brainDir));
  const registryOpts = opts.registryPath ? { registryPath: opts.registryPath } : {};
  const existing = new Set(
    ((await loadRegistryFile(registryOpts))?.rules ?? []).map((r) => ruleMatcherKey(r)),
  );
  for (const org of orgs) {
    const rule = { org: `${org}/*`, brain: brainDir };
    if (existing.has(ruleMatcherKey(rule))) {
      log(`  org:${org}/*  kept your existing rule`);
      continue;
    }
    await addRule(rule, registryOpts);
    log(`  org:${org}/*  → this brain`);
  }
  if (orgs.length === 0) {
    log(
      "  The brain lists no projects yet; route repos with `commonwealth add` or `commonwealth registry`.",
    );
  }
  const shared = await importSharedRules(brainDir, registryOpts);
  if (shared.imported > 0) log(`  ${shared.imported} shared rule(s) imported from the brain`);
  log(
    "Next: install the plugin (`claude plugin install commonwealth@commonwealth`) and start a new session.",
  );
  return 0;
}

/** `commonwealth person merge <keep-id> <drop-id>`: one human, two contributor identities. */
export async function cmdPerson(rest: string[]): Promise<number> {
  const [sub, keepId, dropId, ...extra] = rest;
  if (sub !== "merge" || !keepId || !dropId || extra.length > 0) {
    process.stderr.write("usage: commonwealth person merge <keep-id> <drop-id>\n");
    return 2;
  }
  const brainDir = await resolveBrainDir(process.cwd());
  if (!brainDir) {
    process.stderr.write(
      "No brain is mapped to this folder; run it inside a wired repo or the brain.\n",
    );
    return 1;
  }
  const { rewritten } = await mergePeople(brainDir, keepId, dropId);
  await regenerateDerived(brainDir, { prune: true });
  process.stdout.write(
    `Merged ${dropId} into ${keepId}: ${rewritten} note(s) re-attributed; both emails now attribute to ${keepId}.\n`,
  );
  return 0;
}
