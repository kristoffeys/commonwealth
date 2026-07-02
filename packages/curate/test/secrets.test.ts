import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { curate } from "../src/curate.js";
import { listStaged } from "../src/staging.js";

let brainDir: string;

beforeEach(async () => {
  brainDir = await fs.mkdtemp(path.join(tmpdir(), "commonwealth-curate-secrets-"));
});

afterEach(async () => {
  await fs.rm(brainDir, { recursive: true, force: true });
});

describe("curate secret gate (#16)", () => {
  it("rejects a candidate whose body contains an AWS key and does not stage it", async () => {
    const result = await curate(brainDir, [
      {
        kind: "memory",
        title: "Deploy credentials",
        body: "Use AKIAIOSFODNN7EXAMPLE to authenticate against the deploy bucket.",
      },
    ]);

    expect(result.staged).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toBe("contains-secret");

    const pending = await listStaged(brainDir);
    expect(pending).toHaveLength(0);
  });

  it("does not leak the raw secret and does not fold it into dedupe", async () => {
    // A second, clean candidate that shares wording must still stage — proof the rejected
    // secret candidate never entered the `existing` dedupe set.
    const result = await curate(brainDir, [
      {
        kind: "memory",
        title: "Token config",
        body: "password = hunter2verylong is the shared staging login secret value.",
      },
      {
        kind: "memory",
        title: "Deploy pipeline overview",
        body: "The deploy pipeline runs on every push to the main branch and then notifies.",
      },
    ]);

    expect(result.rejected[0]?.reason).toBe("contains-secret");
    expect(result.staged).toHaveLength(1);
    expect(result.staged[0]?.frontmatter.title).toBe("Deploy pipeline overview");
  });

  it("rejects a candidate hiding a secret in its tags (not just title/body) (#99)", async () => {
    const result = await curate(brainDir, [
      {
        kind: "memory",
        title: "Bucket naming convention",
        body: "Deploy buckets follow the team-region-env naming convention across projects.",
        tags: ["infra", "AKIAIOSFODNN7EXAMPLE"], // secret smuggled into a tag
      },
    ]);
    expect(result.staged).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe("contains-secret");
    expect(await listStaged(brainDir)).toHaveLength(0);
  });

  it("rejects a candidate hiding a secret in a kind-specific field (#99)", async () => {
    const result = await curate(brainDir, [
      {
        kind: "person",
        title: "Ops contact",
        body: "Primary on-call contact for the deploy pipeline and its cloud credentials.",
        fields: { name: "Dana", org: "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
      },
    ]);
    expect(result.staged).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe("contains-secret");
  });

  it("stages a clean candidate unchanged", async () => {
    const result = await curate(brainDir, [
      {
        kind: "memory",
        title: "Search uses FTS5",
        body: "Lexical search is backed by SQLite FTS5; embeddings arrive later behind a seam.",
      },
    ]);

    expect(result.rejected).toHaveLength(0);
    expect(result.staged).toHaveLength(1);
    const pending = await listStaged(brainDir);
    expect(pending).toHaveLength(1);
  });
});
