import { describe, expect, it } from "vitest";
import type { SyncSummary } from "../src/engine";
import { formatSyncSummary } from "../src/format";

const base: SyncSummary = {
  committed: true,
  pulled: true,
  pushed: true,
  conflicts: [],
  secretsBlocked: [],
  skippedLocked: false,
};

describe("formatSyncSummary (#99)", () => {
  it("reports the one-line status with no secret line when nothing was withheld", () => {
    const out = formatSyncSummary(base);
    expect(out).toContain("committed=true pulled=true pushed=true conflicts=0");
    expect(out).not.toContain("withheld");
    expect(out.split("\n")).toHaveLength(1);
  });

  it("adds a visible second line naming every withheld secret note", () => {
    const out = formatSyncSummary({
      ...base,
      secretsBlocked: ["memory/a.md", "work-state/b.md"],
    });
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("withheld 2 note(s)");
    expect(lines[1]).toContain("memory/a.md");
    expect(lines[1]).toContain("work-state/b.md");
  });
});
