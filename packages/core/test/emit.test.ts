import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { emitAgentContext, initBrain, renderAgentContext, writeNote } from "../src/index.js";
import type { Note } from "../src/index.js";

/**
 * Agent-context emitter renderer (#135). Slices canon by project, excludes superseded notes,
 * renders deterministically (so a committed AGENTS.md block never churns), and respects the budget.
 */
describe("renderAgentContext", () => {
  const note = (
    over: Partial<Note["frontmatter"]> & { kind: Note["frontmatter"]["kind"] },
    body = "",
  ): Note =>
    ({
      frontmatter: {
        id: "id",
        title: "T",
        tags: [],
        created: "2026-01-01",
        source: "acme/app",
        ...over,
      } as Note["frontmatter"],
      body,
      path: `${over.kind}/id.md`,
    }) as Note;

  it("slices to the given project and omits other projects", () => {
    const notes = [
      note({ id: "a", kind: "memory", title: "Ours", source: "acme/app" }, "our fact"),
      note({ id: "b", kind: "memory", title: "Theirs", source: "other/repo" }, "their fact"),
    ];
    const out = renderAgentContext(notes, { projectSource: "acme/app" });
    expect(out).toContain("acme/app");
    expect(out).toContain("Ours");
    expect(out).not.toContain("Theirs");
  });

  it("excludes superseded notes (canon only, #133)", () => {
    const notes = [
      note(
        { id: "d1", kind: "decision", title: "Live decision", deciders: [] } as never,
        "current",
      ),
      note(
        {
          id: "d0",
          kind: "decision",
          title: "Old decision",
          deciders: [],
          superseded_by: "d1",
        } as never,
        "outdated",
      ),
    ];
    const out = renderAgentContext(notes, { projectSource: "acme/app" });
    expect(out).toContain("Live decision");
    expect(out).not.toContain("Old decision");
  });

  it("groups by kind into Decisions / Active work / Key facts", () => {
    const notes = [
      note({ id: "m", kind: "memory", title: "A fact" }, "the fact body"),
      note(
        { id: "d", kind: "decision", title: "A decision", deciders: [] } as never,
        "the decision body",
      ),
      note(
        { id: "w", kind: "work-state", title: "In flight", status: "in-progress" } as never,
        "wip",
      ),
    ];
    const out = renderAgentContext(notes, { projectSource: "acme/app" });
    expect(out).toContain("## Decisions");
    expect(out).toContain("## Active work");
    expect(out).toContain("## Key facts");
    expect(out).not.toContain("In flight [done]");
  });

  it("drops done work-state from Active work", () => {
    const notes = [
      note({ id: "w", kind: "work-state", title: "Finished", status: "done" } as never, "done"),
    ];
    const out = renderAgentContext(notes, { projectSource: "acme/app" });
    expect(out).not.toContain("Finished");
  });

  it("is deterministic — identical input yields identical output (no timestamp/churn)", () => {
    const notes = [note({ id: "m", kind: "memory", title: "Fact" }, "body")];
    expect(renderAgentContext(notes, { projectSource: "acme/app" })).toBe(
      renderAgentContext(notes, { projectSource: "acme/app" }),
    );
  });

  it("respects the character budget", () => {
    const notes = Array.from({ length: 50 }, (_, i) =>
      note(
        { id: `m${String(i).padStart(2, "0")}`, kind: "memory", title: `Fact ${i}` },
        "x".repeat(200),
      ),
    );
    const out = renderAgentContext(notes, { projectSource: "acme/app", maxChars: 1000 });
    expect(out.length).toBeLessThan(1500); // budget honored (small overshoot for the last item)
  });

  it("renders an empty-state block for a project with no canon", () => {
    const out = renderAgentContext([], { projectSource: "acme/app" });
    expect(out).toContain("No canonical notes");
  });

  it("emitAgentContext reads a real brain", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cw-emit-core-"));
    try {
      await initBrain(dir, { name: "b" });
      await writeNote(dir, {
        kind: "memory",
        title: "Zappa fact",
        body: "known only here",
        source: "acme/app",
      });
      const out = await emitAgentContext(dir, { projectSource: "acme/app" });
      expect(out).toContain("Zappa fact");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
