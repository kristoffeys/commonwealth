import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeNoteId } from "../src/ids";
import { listNotes, writeNote } from "../src/notes";

/**
 * The moat (issue #2, ADR-0003): two teammates writing "at the same time" must never
 * produce a git conflict. Because each note is an atomic file with a collision-proof
 * id, divergent branches adding notes merge as a clean union.
 */

let dir: string;
const git = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "commons-concur-")));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "Test"]);
  await fs.mkdir(path.join(dir, "memory"), { recursive: true });
  await fs.writeFile(path.join(dir, "memory", ".gitkeep"), "");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("concurrent writes union-merge without conflict", () => {
  it("same title+date on two branches produce distinct files that merge cleanly", async () => {
    // Two writers pick the SAME title and date — the worst case for collisions.
    const title = "Shared insight";
    const date = "2026-07-01";

    git(["checkout", "-q", "-b", "alice"]);
    const a = await writeNote(dir, { kind: "memory", title, body: "Alice's take", created: date });
    git(["add", "-A"]);
    git(["commit", "-qm", "alice note"]);

    git(["checkout", "-q", "main"]);
    git(["checkout", "-q", "-b", "bob"]);
    const b = await writeNote(dir, { kind: "memory", title, body: "Bob's take", created: date });
    git(["add", "-A"]);
    git(["commit", "-qm", "bob note"]);

    // Distinct filenames despite identical title+date (random suffix).
    expect(a.path).not.toBe(b.path);

    // Merge both branches into main — must be conflict-free.
    git(["checkout", "-q", "main"]);
    git(["merge", "-q", "--no-edit", "alice"]);
    expect(() => git(["merge", "-q", "--no-edit", "bob"])).not.toThrow();

    // Both notes survive the merge as a union.
    const notes = await listNotes(dir, "memory");
    const bodies = notes.map((n) => n.body).sort();
    expect(bodies).toEqual(["Alice's take", "Bob's take"]);
  });

  it("makeNoteId uses a random suffix so repeated calls differ", () => {
    const ids = new Set(Array.from({ length: 50 }, () => makeNoteId("Same", "2026-07-01")));
    expect(ids.size).toBe(50);
  });
});
