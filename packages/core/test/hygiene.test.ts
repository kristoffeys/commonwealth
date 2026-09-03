import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bodyWikilinks, lintBrain } from "../src/hygiene.js";
import { regenerateDerived, writeNote } from "../src/index.js";

/**
 * `lintBrain` (#258) — the vault-hygiene lint. Builds real brains with `writeNote`/hand-written
 * files, then asserts the exact rule/severity that fires (or doesn't), mirroring the fixture style
 * of verify.test.ts and health.test.ts.
 */
describe("lintBrain", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cw-hygiene-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const findingsFor = (report: Awaited<ReturnType<typeof lintBrain>>, rule: string) =>
    report.findings.filter((f) => f.rule === rule);

  it("throws when the brain directory does not exist", async () => {
    const missing = path.join(dir, "does-not-exist");
    await expect(lintBrain(missing)).rejects.toThrow(/Not a brain directory/);
  });

  it("lints a clean brain clean", async () => {
    await writeNote(dir, { kind: "memory", title: "Alpha", body: "the alpha fact" });
    await writeNote(dir, {
      kind: "decision",
      title: "Beta",
      body: "the beta decision",
      fields: { deciders: [] },
    });
    await regenerateDerived(dir);

    const report = await lintBrain(dir);
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.staleDerived).toEqual([]);
  });

  it("flags a dead-supersede reference as an error", async () => {
    await writeNote(dir, {
      kind: "memory",
      title: "Dangling",
      body: "x",
      fields: { superseded_by: "does-not-exist" },
    });
    const report = await lintBrain(dir);
    const findings = findingsFor(report, "dead-supersede");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(report.ok).toBe(false);
  });

  it("does not flag a supersede reference that resolves", async () => {
    const target = await writeNote(dir, { kind: "memory", title: "Target", body: "x" });
    await writeNote(dir, {
      kind: "memory",
      title: "Source",
      body: "x",
      fields: { superseded_by: target.frontmatter.id },
    });
    const report = await lintBrain(dir);
    expect(findingsFor(report, "dead-supersede")).toEqual([]);
    expect(findingsFor(report, "supersede-kind")).toEqual([]);
  });

  it("flags a supersede reference to a non-supersedeable kind as a warn, not an error", async () => {
    const target = await writeNote(dir, {
      kind: "work-state",
      title: "Open question",
      body: "x",
      fields: { status: "in-progress" },
    });
    await writeNote(dir, {
      kind: "decision",
      title: "Decides it",
      body: "x",
      fields: { deciders: [], supersedes: [target.frontmatter.id] },
    });
    const report = await lintBrain(dir);
    const findings = findingsFor(report, "supersede-kind");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("warn");
    expect(report.ok).toBe(true);
  });

  it("flags a note that fails to parse as a schema error with a readable message", async () => {
    await fs.mkdir(path.join(dir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "memory", "broken.md"),
      "---\nid: broken\nkind: memory\n---\nno title or created\n",
    );
    const report = await lintBrain(dir);
    const findings = findingsFor(report, "schema");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toContain("title");
    expect(findings[0]!.message).toContain("created");
    expect(findings[0]!.message).not.toContain("[");
    expect(report.ok).toBe(false);
  });

  it("flags a desynced id/filename as an id-path error", async () => {
    await fs.mkdir(path.join(dir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "memory", "wrong-stem.md"),
      "---\nid: actual-id\nkind: memory\ntitle: Something\ncreated: 2026-01-01\n---\nbody\n",
    );
    const report = await lintBrain(dir);
    const findings = findingsFor(report, "id-path");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(report.ok).toBe(false);
  });

  it("flags a note filed in the wrong kind folder as a kind-dir warn", async () => {
    const note = await writeNote(dir, {
      kind: "decision",
      title: "Filed wrong",
      body: "x",
      fields: { deciders: [] },
    });
    const misfiled = path.join(dir, "memory", path.basename(note.path));
    await fs.mkdir(path.join(dir, "memory"), { recursive: true });
    await fs.rename(path.join(dir, note.path), misfiled);

    const report = await lintBrain(dir);
    const findings = findingsFor(report, "kind-dir");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("warn");
    expect(report.ok).toBe(true);
  });

  it("flags an unresolvable relates entry and an unresolvable body wikilink as dead-link warns", async () => {
    await writeNote(dir, {
      kind: "memory",
      title: "Has dead refs",
      body: "See [[nonexistent-note]] for more.",
      fields: { relates: ["ghost-id"] },
    });
    const report = await lintBrain(dir);
    const findings = findingsFor(report, "dead-link");
    expect(findings).toHaveLength(2);
    for (const f of findings) expect(f.severity).toBe("warn");
  });

  it("resolves a body wikilink to an existing note's title case-insensitively, including decoration", async () => {
    await writeNote(dir, { kind: "memory", title: "Target Note", body: "the fact" });
    await writeNote(dir, {
      kind: "memory",
      title: "Source",
      body: "See [[target note]], [[target note|a label]], and [[target note#some-heading]].",
    });
    const report = await lintBrain(dir);
    expect(findingsFor(report, "dead-link")).toEqual([]);
  });

  it("never flags cross-brain or non-note references (anti-false-positive contract)", async () => {
    await writeNote(dir, {
      kind: "memory",
      title: "Graduated fact",
      body: "free text mention of some-project",
      fields: {
        relates: ["some-brain/some-id"],
        sources: ["https://example.com/article", "just some free text provenance"],
      },
    });
    await regenerateDerived(dir);
    const report = await lintBrain(dir);
    expect(report.findings).toEqual([]);
  });

  describe("bodyWikilinks", () => {
    /**
     * A `[[…]]` inside code is documenting the syntax, not linking to a note — markdown renders no
     * link there and neither does Obsidian. Every row here is a code form that appears in real
     * notes; the `ghost-*` targets must be invisible and the `real-*` ones must survive. The
     * indented, blockquoted and multi-backtick rows are regressions: an earlier version anchored the
     * fence patterns at column zero, so a fence nested in a list item — the most common way a note
     * carries an example — leaked its contents as dead links.
     */
    const cases: [name: string, body: string, expected: string[]][] = [
      ["bare prose", "See [[real-a]] here.", ["real-a"]],
      [
        "unindented fence",
        ["a", "```", "[[ghost-b]]", "```", "b [[real-b]]"].join("\n"),
        ["real-b"],
      ],
      [
        "fence indented inside a list item",
        ["- item:", "  ```md", "  [[ghost-d]]", "  ```", "- [[real-d]]"].join("\n"),
        ["real-d"],
      ],
      [
        "fence inside a blockquote",
        ["> ```", "> [[ghost-i]]", "> ```", "[[real-i]]"].join("\n"),
        ["real-i"],
      ],
      [
        "indented tilde fence",
        ["  ~~~", "  [[ghost-h]]", "  ~~~", "[[real-h]]"].join("\n"),
        ["real-h"],
      ],
      ["single-backtick span", "use `[[ghost-c]]` syntax; [[real-c]]", ["real-c"]],
      ["double-backtick span", "use ``[[ghost-f]]`` syntax; [[real-f]]", ["real-f"]],
      [
        "four-backtick fence wrapping a three-backtick one",
        ["````", "```", "[[ghost-g]]", "```", "````", "[[real-g]]"].join("\n"),
        ["real-g"],
      ],
      [
        "unterminated fence runs to end of note",
        ["[[real-j]]", "```", "[[ghost-j]]"].join("\n"),
        ["real-j"],
      ],
      [
        // Four-space indentation under a list item is continuation PROSE, not a code block. Stripping
        // it would blind the lint to real dead links in the most ordinary nested-list note there is.
        "four-space list continuation is prose, not code",
        ["- item", "    continued [[real-k]]"].join("\n"),
        ["real-k"],
      ],
      [
        "duplicates collapse",
        ["See [[real-link]].", "And [[real-link]] again."].join("\n"),
        ["real-link"],
      ],
    ];

    it.each(cases)("%s", (_name, body, expected) => {
      expect(bodyWikilinks(body)).toEqual(expected);
    });
  });

  it("reports no dead link for a convention note whose example fence is indented in a list", async () => {
    await writeNote(dir, {
      kind: "memory",
      title: "How we write notes",
      body: [
        "Conventions:",
        "",
        "- link related notes like this:",
        "  ```yaml",
        "  relates:",
        "    - 2026-01-01-some-note-abcd",
        "  ```",
        "- and in prose with `[[another-example-id]]`",
      ].join("\n"),
    });
    const report = await lintBrain(dir);
    expect(findingsFor(report, "dead-link")).toEqual([]);
  });

  it("names every file when two notes share an id, rather than one path twice", async () => {
    const frontmatter = (kind: string, extra = "") =>
      `---\nid: 2026-09-03-dup-bbbb\nkind: ${kind}\ntitle: Duplicated id\ncreated: 2026-09-03\n${extra}---\nbody\n`;
    await fs.mkdir(path.join(dir, "memory"), { recursive: true });
    await fs.mkdir(path.join(dir, "decisions"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "memory", "2026-09-03-dup-bbbb.md"),
      frontmatter("memory", "status: active\n"),
    );
    await fs.writeFile(
      path.join(dir, "decisions", "2026-09-03-dup-bbbb.md"),
      frontmatter("decision", "status: accepted\ndeciders: []\n"),
    );

    const report = await lintBrain(dir, { reportOrphans: true });
    const paths = findingsFor(report, "orphan")
      .map((f) => f.where)
      .sort();
    expect(paths).toEqual(["decisions/2026-09-03-dup-bbbb.md", "memory/2026-09-03-dup-bbbb.md"]);
    // The count is of distinct orphaned IDS, so the shared id counts once.
    expect(report.orphanCount).toBe(1);
  });

  it("warns dead-author-ref when author_ref names a missing note", async () => {
    await writeNote(dir, {
      kind: "memory",
      title: "Authored",
      body: "x",
      authorRef: "nobody",
    });
    const report = await lintBrain(dir);
    const findings = findingsFor(report, "dead-author-ref");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("warn");
  });

  it("warns dead-author-ref when author_ref names a note that is not kind: person", async () => {
    const other = await writeNote(dir, { kind: "memory", title: "Not a person", body: "x" });
    await writeNote(dir, {
      kind: "memory",
      title: "Authored",
      body: "x",
      authorRef: other.frontmatter.id,
    });
    const report = await lintBrain(dir);
    expect(findingsFor(report, "dead-author-ref")).toHaveLength(1);
  });

  it("does not flag author_ref naming a real person note", async () => {
    const person = await writeNote(dir, {
      kind: "person",
      title: "A Person",
      body: "x",
      fields: { name: "A Person", role: "engineer" },
    });
    await writeNote(dir, {
      kind: "memory",
      title: "Authored",
      body: "x",
      authorRef: person.frontmatter.id,
    });
    const report = await lintBrain(dir);
    expect(findingsFor(report, "dead-author-ref")).toEqual([]);
  });

  it("reports stale-derived before regeneration and clears it after", async () => {
    await writeNote(dir, { kind: "memory", title: "Alpha", body: "x" });

    const stale = await lintBrain(dir);
    expect(stale.staleDerived).toContain("COMMONWEALTH.md");
    expect(findingsFor(stale, "stale-derived").length).toBeGreaterThan(0);

    await regenerateDerived(dir);
    const fresh = await lintBrain(dir);
    expect(fresh.staleDerived).not.toContain("COMMONWEALTH.md");

    const skipped = await lintBrain(dir, { checkDerived: false });
    expect(findingsFor(skipped, "stale-derived")).toEqual([]);
  });

  it("always populates orphanCount; reportOrphans adds one info finding per orphan", async () => {
    await writeNote(dir, { kind: "memory", title: "Alone", body: "x" });

    const withoutFlag = await lintBrain(dir);
    expect(withoutFlag.orphanCount).toBe(1);
    expect(findingsFor(withoutFlag, "orphan")).toEqual([]);

    const withFlag = await lintBrain(dir, { reportOrphans: true });
    expect(withFlag.orphanCount).toBe(1);
    const findings = findingsFor(withFlag, "orphan");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("info");
  });

  it("never writes: mtime and content of COMMONWEALTH.md and a note are unchanged after a lint of a stale brain", async () => {
    const note = await writeNote(dir, {
      kind: "work-state",
      title: "Alpha",
      body: "x",
      fields: { status: "in-progress" },
    });
    await regenerateDerived(dir);
    // Make it stale again without regenerating: a new active work-state note changes COMMONWEALTH.md.
    await writeNote(dir, {
      kind: "work-state",
      title: "Beta",
      body: "y",
      fields: { status: "in-progress" },
    });

    const commonwealthPath = path.join(dir, "COMMONWEALTH.md");
    const notePath = path.join(dir, note.path);
    const beforeCommonwealth = await fs.stat(commonwealthPath);
    const beforeNote = await fs.stat(notePath);
    const beforeCommonwealthContent = await fs.readFile(commonwealthPath, "utf8");
    const beforeNoteContent = await fs.readFile(notePath, "utf8");

    const report = await lintBrain(dir);
    expect(report.staleDerived).toContain("COMMONWEALTH.md");

    const afterCommonwealth = await fs.stat(commonwealthPath);
    const afterNote = await fs.stat(notePath);
    expect(afterCommonwealth.mtimeMs).toBe(beforeCommonwealth.mtimeMs);
    expect(afterNote.mtimeMs).toBe(beforeNote.mtimeMs);
    expect(await fs.readFile(commonwealthPath, "utf8")).toBe(beforeCommonwealthContent);
    expect(await fs.readFile(notePath, "utf8")).toBe(beforeNoteContent);
  });
});
