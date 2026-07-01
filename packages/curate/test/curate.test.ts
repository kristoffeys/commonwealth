import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setFeature, writeNote } from "@commons/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { curate } from "../src/curate.js";
import { listStaged } from "../src/staging.js";

let brainDir: string;

beforeEach(async () => {
  brainDir = await fs.mkdtemp(path.join(tmpdir(), "commons-curate-curate-"));
});

afterEach(async () => {
  await fs.rm(brainDir, { recursive: true, force: true });
});

describe("curate", () => {
  it("rejects a too-thin candidate", async () => {
    const result = await curate(brainDir, [{ kind: "memory", title: "", body: "" }]);
    expect(result.staged).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toBe("too-thin");
  });

  it("rejects a candidate near-identical to an existing canon note", async () => {
    const canon = await writeNote(brainDir, {
      kind: "memory",
      title: "Auth uses OAuth device flow",
      body: "The service authenticates clients with the OAuth 2.0 device authorization flow.",
    });

    const result = await curate(brainDir, [
      {
        kind: "memory",
        title: "Auth uses OAuth device flow",
        body: "The service authenticates clients with the OAuth 2.0 device authorization flow.",
      },
    ]);

    expect(result.staged).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toBe("duplicate");
    expect(result.rejected[0]?.duplicateOf).toBe(canon.frontmatter.id);
  });

  it("stages only one of two near-identical candidates in a batch", async () => {
    const result = await curate(brainDir, [
      {
        kind: "memory",
        title: "Deploy runs on push to main",
        body: "Deployment is triggered automatically whenever a commit lands on the main branch.",
      },
      {
        kind: "memory",
        title: "Deploy runs on push to main",
        body: "Deployment is triggered automatically whenever a commit lands on the main branch.",
      },
    ]);

    expect(result.staged).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toBe("duplicate");
    expect(result.rejected[0]?.duplicateOf).toBe(result.staged[0]?.frontmatter.id);

    const pending = await listStaged(brainDir);
    expect(pending).toHaveLength(1);
  });

  it("stages a novel candidate", async () => {
    // `decision` kind is gated by autoAdr (ADR-0009); enable it for this staging test.
    await setFeature(brainDir, "autoAdr", true);
    const result = await curate(brainDir, [
      {
        kind: "decision",
        title: "Use SQLite FTS5 for search",
        body: "We picked lexical FTS5 search for phase one; embeddings come later behind a seam.",
      },
    ]);

    expect(result.rejected).toHaveLength(0);
    expect(result.staged).toHaveLength(1);

    const pending = await listStaged(brainDir);
    expect(pending.map((n) => n.frontmatter.id)).toContain(result.staged[0]?.frontmatter.id);
  });
});
