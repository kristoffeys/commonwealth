import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setFeature } from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { curate } from "../src/curate.js";
import { listStaged } from "../src/staging.js";

let brainDir: string;

beforeEach(async () => {
  brainDir = await fs.mkdtemp(path.join(tmpdir(), "commonwealth-curate-autoadr-"));
});

afterEach(async () => {
  await fs.rm(brainDir, { recursive: true, force: true });
});

const decisionCandidate = {
  kind: "decision" as const,
  title: "Adopt trunk-based development",
  body: "We will commit to short-lived branches merged to main daily to reduce integration pain.",
};

const memoryCandidate = {
  kind: "memory" as const,
  title: "CI runs on GitHub Actions",
  body: "The continuous integration pipeline is defined in .github/workflows and runs on push.",
};

describe("autoAdr gate", () => {
  it("rejects decisions with auto-adr-disabled when the flag is off (default)", async () => {
    const result = await curate(brainDir, [decisionCandidate, memoryCandidate]);

    expect(result.staged).toHaveLength(1);
    expect(result.staged[0]?.frontmatter.kind).toBe("memory");

    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toBe("auto-adr-disabled");
    expect(result.rejected[0]?.candidate.kind).toBe("decision");

    const staged = await listStaged(brainDir);
    expect(staged).toHaveLength(1);
    expect(staged[0]?.frontmatter.kind).toBe("memory");
  });

  it("stages decisions once autoAdr is enabled", async () => {
    await setFeature(brainDir, "autoAdr", true);

    const result = await curate(brainDir, [decisionCandidate]);

    expect(result.rejected).toHaveLength(0);
    expect(result.staged).toHaveLength(1);
    expect(result.staged[0]?.frontmatter.kind).toBe("decision");

    const staged = await listStaged(brainDir);
    expect(staged.map((n) => n.frontmatter.id)).toContain(result.staged[0]?.frontmatter.id);
  });
});
