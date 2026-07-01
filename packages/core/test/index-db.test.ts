import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildIndex, regenerateDerived, search } from "../src/index-db";
import { writeNote } from "../src/notes";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-index-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function seed() {
  await writeNote(dir, { kind: "memory", title: "Auth design", body: "JWT with refresh token" });
  await writeNote(dir, { kind: "memory", title: "Billing quirk", body: "auth header required" });
  await writeNote(dir, {
    kind: "decision",
    title: "Use Postgres",
    body: "chosen for reliability",
    fields: { status: "accepted" },
  });
}

describe("buildIndex", () => {
  it("indexes every note and does not accumulate on rebuild", async () => {
    await seed();
    expect((await buildIndex(dir)).indexed).toBe(3);
    // "auth" appears in two notes; rebuilding must not double the rows.
    await buildIndex(dir);
    const hits = await search(dir, "auth");
    expect(hits).toHaveLength(2);
  });
});

describe("search", () => {
  it("builds on demand when the db is absent", async () => {
    await seed();
    // No explicit buildIndex call.
    const hits = await search(dir, "JWT");
    expect(hits.map((h) => h.title)).toContain("Auth design");
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  it("filters by kind and honors limit", async () => {
    await seed();
    await buildIndex(dir);
    const decisions = await search(dir, "Postgres", { kind: "decision" });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.kind).toBe("decision");
    const limited = await search(dir, "auth", { limit: 1 });
    expect(limited).toHaveLength(1);
  });

  it("returns [] for an empty/whitespace query", async () => {
    await seed();
    await buildIndex(dir);
    expect(await search(dir, "   ")).toEqual([]);
  });
});

describe("regenerateDerived", () => {
  it("is byte-idempotent for COMMONWEALTH.md and INDEX.md across runs", async () => {
    await seed();
    await regenerateDerived(dir);
    const read = async () => ({
      commonwealth: await fs.readFile(path.join(dir, "COMMONWEALTH.md"), "utf8"),
      memIndex: await fs.readFile(path.join(dir, "memory", "INDEX.md"), "utf8"),
    });
    const first = await read();
    await regenerateDerived(dir);
    expect(await read()).toEqual(first);
  });

  it("lists active work-state and excludes done", async () => {
    await writeNote(dir, {
      kind: "work-state",
      title: "Migration underway",
      body: "x",
      fields: { status: "in-progress" },
    });
    await writeNote(dir, {
      kind: "work-state",
      title: "Old rollout",
      body: "x",
      fields: { status: "done" },
    });
    await regenerateDerived(dir);
    const commonwealth = await fs.readFile(path.join(dir, "COMMONWEALTH.md"), "utf8");
    expect(commonwealth).toContain("Migration underway");
    expect(commonwealth).not.toContain("Old rollout");
  });
});
