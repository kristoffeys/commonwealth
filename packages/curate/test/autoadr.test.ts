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
  it("stages decisions by default (autoAdr defaults on; ADR-0022)", async () => {
    const result = await curate(brainDir, [decisionCandidate, memoryCandidate]);

    expect(result.rejected).toHaveLength(0);
    expect(result.staged.map((n) => n.frontmatter.kind).sort()).toEqual(["decision", "memory"]);

    const staged = await listStaged(brainDir);
    expect(staged).toHaveLength(2);
  });

  it("rejects decisions with auto-adr-disabled once the flag is turned off", async () => {
    await setFeature(brainDir, "autoAdr", false);

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

  it("records decision provenance — deciders + status — through the gate (the /decide path)", async () => {
    const result = await curate(brainDir, [
      {
        kind: "decision",
        title: "Use Postgres for the ledger",
        body: "Chose Postgres over DynamoDB for the money ledger: we need multi-row transactions.",
        fields: { deciders: ["ana", "wei"], status: "accepted" },
      },
    ]);

    expect(result.staged).toHaveLength(1);
    const fm = result.staged[0]?.frontmatter;
    expect(fm?.kind).toBe("decision");
    // who + when + status are traced; when (created) is stamped automatically.
    expect(fm && "deciders" in fm ? fm.deciders : undefined).toEqual(["ana", "wei"]);
    expect(fm && "status" in fm ? fm.status : undefined).toBe("accepted");
    expect(fm?.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
