import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listNotes } from "@commons/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listStaged, stageNote, stagedAbsPath } from "../src/staging.js";

let brainDir: string;

beforeEach(async () => {
  brainDir = await fs.mkdtemp(path.join(tmpdir(), "commons-curate-staging-"));
});

afterEach(async () => {
  await fs.rm(brainDir, { recursive: true, force: true });
});

describe("staging", () => {
  it("writes staged notes under staging/<dir>/ and keeps them out of canon", async () => {
    const staged = await stageNote(brainDir, {
      kind: "memory",
      title: "Staged fact",
      body: "This fact is proposed but not yet approved.",
    });

    // path is relative to the staging root.
    expect(staged.path).toMatch(/^memory\/.*\.md$/);

    // File exists physically under staging/.
    const abs = stagedAbsPath(brainDir, staged);
    expect(abs).toContain(path.join(brainDir, "staging", "memory"));
    await expect(fs.stat(abs)).resolves.toBeDefined();

    // Not visible in canon.
    const canon = await listNotes(brainDir);
    expect(canon.map((n) => n.frontmatter.id)).not.toContain(staged.frontmatter.id);

    // But visible via listStaged.
    const pending = await listStaged(brainDir);
    expect(pending.map((n) => n.frontmatter.id)).toContain(staged.frontmatter.id);
  });
});
