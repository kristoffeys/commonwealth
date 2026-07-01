import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { importConfigs } from "../src/config-importer.js";

describe("importConfigs", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), "seed-config-"));
    writeFileSync(path.join(repo, "CLAUDE.md"), "# Working guide\n\nBe careful.\n");
    writeFileSync(path.join(repo, ".cursorrules"), "Always write tests.\n");
    const rulesDir = path.join(repo, ".claude", "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(path.join(rulesDir, "x.md"), "Rule x: prefer composition.\n");
  });

  it("imports CLAUDE.md + .cursorrules + .claude/rules/*.md as 3 config memory notes", async () => {
    const notes = await importConfigs(repo);
    expect(notes).toHaveLength(3);
    for (const note of notes) {
      expect(note.kind).toBe("memory");
      expect(note.tags).toEqual(["config", "seed"]);
    }
  });

  it("uses the file's first heading as title when present, otherwise a fallback", async () => {
    const notes = await importConfigs(repo);
    const titles = notes.map((n) => n.title);
    expect(titles).toContain("Working guide"); // CLAUDE.md heading
    expect(titles).toContain("Project config: .cursorrules"); // no heading → fallback
  });

  it("includes the file contents in the body", async () => {
    const notes = await importConfigs(repo);
    const cursor = notes.find((n) => n.title === "Project config: .cursorrules")!;
    expect(cursor.body).toContain("Always write tests.");
    const rule = notes.find((n) => n.body.includes("prefer composition"))!;
    expect(rule).toBeTruthy();
  });

  it("ignores missing files silently (empty repo → [])", async () => {
    const empty = mkdtempSync(path.join(tmpdir(), "seed-empty-"));
    const notes = await importConfigs(empty);
    expect(notes).toEqual([]);
  });

  it("is deterministic and sorted by path", async () => {
    const first = await importConfigs(repo);
    const second = await importConfigs(repo);
    expect(second).toEqual(first);
  });
});
