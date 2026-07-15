import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attributeNoteInputs,
  contributorPersonId,
  ensureContributorPerson,
  resolveContributorIdentity,
  type ContributorIdentity,
} from "../src/attribution.js";
import { listNotes, writeNote } from "../src/notes.js";

let brainDir: string;

beforeEach(async () => {
  brainDir = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-attribution-"));
});

afterEach(async () => {
  await fs.rm(brainDir, { recursive: true, force: true });
});

const kristof: ContributorIdentity = {
  name: "Kristof Feys",
  email: "kristof@example.com",
  key: `email-sha256:${createHash("sha256").update("kristof@example.com").digest("hex")}`,
};

async function contributorLockPath(name: string): Promise<string> {
  const canonicalBrain = await fs.realpath(brainDir);
  const brainHash = createHash("sha256").update(canonicalBrain).digest("hex").slice(0, 16);
  const nameHash = createHash("sha256").update(name.toLowerCase()).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), "commonwealth-contributor-locks", brainHash, nameHash);
}

describe("contributor identity", () => {
  it("uses the explicit Commonwealth identity without consulting Git", async () => {
    const runGit = vi.fn(async () => "wrong");
    const identity = await resolveContributorIdentity("/work", {
      env: {
        COMMONWEALTH_AUTHOR: "  Kristof   Feys ",
        COMMONWEALTH_AUTHOR_EMAIL: "KRISTOF@example.com",
      },
      runGit,
    });

    expect(identity).toEqual(kristof);
    expect(runGit).not.toHaveBeenCalled();
  });

  it("falls back to Git name and email", async () => {
    const identity = await resolveContributorIdentity("/work", {
      env: {},
      runGit: async (_cwd, key) => (key === "user.name" ? "Kristof Feys" : "kristof@example.com"),
    });
    expect(identity).toEqual(kristof);
  });
});

describe("person-backed responsibility", () => {
  it("converges concurrent first writes on one deterministic person note", async () => {
    const [a, b] = await Promise.all([
      ensureContributorPerson(brainDir, kristof),
      ensureContributorPerson(brainDir, kristof),
    ]);

    expect(a.frontmatter.id).toBe(contributorPersonId(kristof));
    expect(b.frontmatter.id).toBe(a.frontmatter.id);
    const people = await listNotes(brainDir, "person");
    expect(people).toHaveLength(1);
    expect(people[0]!.frontmatter).toMatchObject({
      kind: "person",
      name: "Kristof Feys",
      attribution_key: kristof.key,
    });
    expect(people[0]!.frontmatter.email).toBeUndefined();
    expect(JSON.stringify(people[0]!.frontmatter)).not.toContain("kristof@example.com");
  });

  it("atomically reclaims one stale reservation across concurrent waiters", async () => {
    const staleLock = await contributorLockPath(kristof.name);
    await fs.mkdir(staleLock, { recursive: true });
    await fs.writeFile(path.join(staleLock, "owner"), "99999999\n", "utf8");

    const people = await Promise.all(
      Array.from({ length: 4 }, () => ensureContributorPerson(brainDir, kristof)),
    );

    expect(new Set(people.map((person) => person.frontmatter.id)).size).toBe(1);
    expect(await listNotes(brainDir, "person")).toHaveLength(1);
  });

  it("never reclaims an old lock whose owner process is still alive", async () => {
    const liveLock = await contributorLockPath(kristof.name);
    await fs.mkdir(liveLock, { recursive: true });
    await fs.writeFile(path.join(liveLock, "owner"), `${process.pid}\n`, "utf8");
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(liveLock, old, old);

    let settled = false;
    const ensure = ensureContributorPerson(brainDir, kristof).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const reclaimedWhileLive = settled;

    await fs.rm(liveLock, { recursive: true, force: true });
    await ensure;
    expect(reclaimedWhileLive).toBe(false);
    expect(await listNotes(brainDir, "person")).toHaveLength(1);
  });

  it("reuses a name-only person when the same identity later gains an email", async () => {
    const nameOnly: ContributorIdentity = {
      name: kristof.name,
      key: `name:${kristof.name.toLowerCase()}`,
    };
    const first = await ensureContributorPerson(brainDir, nameOnly);
    const second = await ensureContributorPerson(brainDir, kristof);
    const differentEmail: ContributorIdentity = {
      name: kristof.name,
      email: "different@example.com",
      key: `email-sha256:${createHash("sha256").update("different@example.com").digest("hex")}`,
    };
    const third = await ensureContributorPerson(brainDir, differentEmail);

    expect(second.frontmatter.id).toBe(first.frontmatter.id);
    expect(second.frontmatter.attribution_key).toBe(kristof.key);
    expect(third.frontmatter.id).not.toBe(first.frontmatter.id);
    expect(await listNotes(brainDir, "person")).toHaveLength(2);
  });

  it("keeps same-name people with different emails separate", async () => {
    const other: ContributorIdentity = {
      name: kristof.name,
      email: "other@example.com",
      key: `email-sha256:${createHash("sha256").update("other@example.com").digest("hex")}`,
    };
    const first = await ensureContributorPerson(brainDir, kristof);
    const second = await ensureContributorPerson(brainDir, other);
    const ambiguousNameOnly = await ensureContributorPerson(brainDir, {
      name: kristof.name,
      key: `name:${kristof.name.toLowerCase()}`,
    });

    expect(second.frontmatter.id).not.toBe(first.frontmatter.id);
    expect(ambiguousNameOnly.frontmatter.id).not.toBe(first.frontmatter.id);
    expect(ambiguousNameOnly.frontmatter.id).not.toBe(second.frontmatter.id);
    expect(await listNotes(brainDir, "person")).toHaveLength(3);
  });

  it("does not guess among multiple same-name name-only people", async () => {
    await writeNote(brainDir, {
      kind: "person",
      title: kristof.name,
      body: "First legacy person without a stable identity key.",
      fields: { name: kristof.name },
    });
    await writeNote(brainDir, {
      kind: "person",
      title: kristof.name,
      body: "Second legacy person without a stable identity key.",
      fields: { name: kristof.name },
    });

    const attributed = await ensureContributorPerson(brainDir, kristof);
    expect(attributed.frontmatter.attribution_key).toBe(kristof.key);
    expect(await listNotes(brainDir, "person")).toHaveLength(3);
  });

  it("rejects a deterministic-id collision with a different identity", async () => {
    await writeNote(brainDir, {
      id: contributorPersonId(kristof),
      kind: "person",
      title: "Different Person",
      body: "A deliberately conflicting identity record.",
      fields: { name: "Different Person", attribution_key: "name:different person" },
    });

    await expect(ensureContributorPerson(brainDir, kristof)).rejects.toThrow("id collision");
  });

  it("links an attributed memory to the contributor person", async () => {
    const attributed = await attributeNoteInputs(
      brainDir,
      [
        {
          kind: "memory",
          title: "Production deploy owner",
          body: "Kristof is responsible for coordinating the production deployment.",
        },
      ],
      kristof,
    );
    const person = await ensureContributorPerson(brainDir, kristof);
    const memory = await writeNote(brainDir, attributed.candidates[0]!);
    const personId = person.frontmatter.id;

    expect(attributed.personId).toBe(personId);
    expect(memory.frontmatter.author).toBe("Kristof Feys");
    expect(memory.frontmatter.author_ref).toBe(personId);
    expect(memory.frontmatter.relates).toContain(personId);
  });
});
