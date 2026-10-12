import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initBrain, listNotes, persistProjectAliasMap, type NewNoteInput } from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureCandidates } from "../src/capture.js";
import { approve, approveAll, listPending } from "../src/review.js";

/**
 * Project-first brain: with a populated registry (`.commonwealth/projects.json`) a note files only
 * under a registered project. Unmatched notes wait in the review queue; repos from orgs the
 * registry doesn't know are refused.
 */

let brainDir: string;

const note = (source: string | undefined, title: string, project?: string): NewNoteInput => ({
  kind: "memory",
  title,
  body: `${title}: a durable fact long enough to clear the relevance gate.`,
  ...(source ? { source } : {}),
  ...(project ? { project } : {}),
});

beforeEach(async () => {
  brainDir = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-capture-registry-"));
  await initBrain(brainDir, { name: "registry-brain" });
  await persistProjectAliasMap(brainDir, (m) => {
    m.o2o = { sources: ["o2o-bicycle-leasing/*"] };
    m.lemahieu = { sources: ["weareantenna/shopware-lemahieu"], names: ["Lemahieu"] };
  });
});

afterEach(async () => {
  await fs.rm(brainDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("capture with a project registry", () => {
  it("files a wildcard-matched repo under its project", async () => {
    const result = await captureCandidates(brainDir, [
      note("o2o-Bicycle-leasing/platform", "Mago rules run nightly"),
    ]);
    expect(result.promoted[0]).toMatch(/^o2o\/memory\//);
  });

  it("files a host-named project (vault cwd) under the registry id", async () => {
    const result = await captureCandidates(brainDir, [
      note("vault", "Certificate groups limit choices", "lemahieu"),
    ]);
    expect(result.promoted[0]).toMatch(/^lemahieu\/memory\//);
    const [canon] = await listNotes(brainDir);
    expect(canon!.frontmatter.source).toBe("vault");
  });

  it("keeps an unmatched note in the review queue, even with autoPromote on", async () => {
    const result = await captureCandidates(brainDir, [
      note("vault", "Artifacts deploy via forced-command ssh", "Antenna Artifacts"),
      note("weareantenna/spardex", "DMS stores files in SeaweedFS"),
    ]);
    expect(result.promoted).toEqual([]);
    expect(await listNotes(brainDir)).toHaveLength(0);
    const pending = await listPending(brainDir);
    expect(pending).toHaveLength(2);
    expect(pending.every((n) => n.frontmatter.project === undefined)).toBe(true);
    expect(await approveAll(brainDir)).toEqual([]);
  });

  it("promotes an unassigned note only with a registry project", async () => {
    await captureCandidates(brainDir, [note("infra", "Terraform state is local")]);
    const [staged] = await listPending(brainDir);
    const id = staged!.frontmatter.id;
    await expect(approve(brainDir, id)).rejects.toThrow(/no project/);
    await expect(approve(brainDir, id, { project: "nope" })).rejects.toThrow(/not a project/);
    expect(await approve(brainDir, id, { project: "lemahieu" })).toMatch(/^lemahieu\/memory\//);
    const [canon] = await listNotes(brainDir);
    expect(canon!.frontmatter.project).toBe("lemahieu");
  });

  it("refuses a repo whose org is not in the registry", async () => {
    const result = await captureCandidates(brainDir, [
      note("kristoffeys/commonwealth", "Release script needs Finder access"),
    ]);
    expect(result.staged).toEqual([]);
    expect(result.rejected[0]!.reason).toBe("outside-registry");
    expect(result.rejected[0]!.drop.category).toBe("outside-registry");
  });
});

describe("capture without a registry", () => {
  it("keeps the old behavior: source folder, declared project as-is", async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-capture-bare-"));
    try {
      await initBrain(bare, { name: "bare" });
      const result = await captureCandidates(bare, [
        note("kristoffeys/commonwealth", "Changesets drive releases"),
        note("vault", "Relay runs claude in the vault", "Relay"),
      ]);
      expect(result.promoted.sort()).toEqual([
        expect.stringMatching(/^Relay\/memory\//),
        expect.stringMatching(/^kristoffeys-commonwealth\/memory\//),
      ]);
    } finally {
      await fs.rm(bare, { recursive: true, force: true });
    }
  });
});
