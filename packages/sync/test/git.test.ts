import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitAllExceptSecrets } from "../src/git";
import { git, makeFixture, type Fixture } from "./helpers";

let fx: Fixture;

beforeEach(async () => {
  fx = await makeFixture();
});
afterEach(async () => {
  await fx.cleanup();
});

describe("commitAllExceptSecrets — non-ASCII note paths (#99)", () => {
  it("scans and withholds a secret in a note with a non-ASCII filename", async () => {
    // A note whose filename has non-ASCII bytes. With core.quotepath default-on, git would
    // report this path octal-escaped + double-quoted, so isNoteFile missed it and the secret
    // was committed. openRepo now forces quotepath=false and stagedFiles reads -z.
    const rel = "memory/café-déploiement.md";
    await fs.writeFile(
      path.join(fx.alice, rel),
      "---\nid: x\nkind: memory\ntitle: T\ncreated: 2026-07-02\n---\n" +
        "The deploy key is AKIAIOSFODNN7EXAMPLE — keep it out of the repo.\n",
      "utf8",
    );

    const result = await commitAllExceptSecrets(fx.alice, "add note");

    // The non-ASCII note was recognized and withheld…
    expect(result.secretsBlocked).toContain(rel);
    // …and never entered a commit.
    const history = git(fx.alice, ["log", "-p"]);
    expect(history).not.toContain("AKIAIOSFODNN7EXAMPLE");
    // …but survives in the working tree for the user to fix.
    expect(await fs.readFile(path.join(fx.alice, rel), "utf8")).toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("still commits a clean non-ASCII note", async () => {
    const rel = "memory/notes-café.md";
    await fs.writeFile(
      path.join(fx.alice, rel),
      "---\nid: y\nkind: memory\ntitle: Clean\ncreated: 2026-07-02\n---\nA perfectly clean note.\n",
      "utf8",
    );
    const result = await commitAllExceptSecrets(fx.alice, "add clean note");
    expect(result.committed).toBe(true);
    expect(result.secretsBlocked).toHaveLength(0);
  });
});
