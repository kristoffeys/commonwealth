import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { isExternalIntake, noteIntake } from "../src/intake";
import { parseNote, serializeNote, writeNote } from "../src/notes";

/**
 * Ingestion trust tier (ADR-0038, #274). The field is additive and optional: an absent `intake`
 * means `internal`, so every note written before the field existed stays valid and the ordinary
 * session capture is byte-identical to a pre-ADR-0038 note.
 */

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-intake-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** A note as written before `intake` existed — the back-compat fixture. */
const PRE_ADR_NOTE = `---
id: 2026-07-01-edge-cache-a1b2
kind: memory
title: Edge cache TTL is five minutes
tags: []
created: 2026-07-01
relates: []
---

The edge cache holds responses for five minutes before revalidating upstream.
`;

describe("intake tier reader", () => {
  it("treats an absent tier as internal", () => {
    expect(noteIntake({})).toBe("internal");
    expect(isExternalIntake({})).toBe(false);
  });

  it("reads a declared tier", () => {
    expect(noteIntake({ intake: "internal" })).toBe("internal");
    expect(noteIntake({ intake: "external" })).toBe("external");
    expect(isExternalIntake({ intake: "external" })).toBe(true);
  });
});

describe("intake round-trip", () => {
  it("persists an external tier to frontmatter and back", async () => {
    const note = await writeNote(dir, {
      kind: "memory",
      title: "Acme wants the invoice split per cost centre",
      body: "Ingested from the Acme billing thread: invoices must be split per cost centre.",
      intake: "external",
    });
    expect(note.frontmatter.intake).toBe("external");
    expect(serializeNote(note)).toContain("intake: external");

    const reread = parseNote(serializeNote(note), note.path);
    expect(noteIntake(reread.frontmatter)).toBe("external");
    expect(isExternalIntake(reread.frontmatter)).toBe(true);
  });

  it("writes no `intake` line when the tier is omitted (differential fixture)", async () => {
    const note = await writeNote(dir, {
      kind: "memory",
      title: "Edge cache TTL is five minutes",
      body: "The edge cache holds responses for five minutes before revalidating upstream.",
    });
    expect(note.frontmatter).not.toHaveProperty("intake");
    expect(serializeNote(note)).not.toContain("intake:");
    // Absence still resolves to a tier — internal — rather than to "unknown".
    expect(noteIntake(note.frontmatter)).toBe("internal");
  });

  it("keeps a pre-ADR-0038 note valid and reads it as internal (no schema-version bump)", () => {
    const note = parseNote(PRE_ADR_NOTE, "memory/2026-07-01-edge-cache-a1b2.md");
    expect(note.frontmatter.id).toBe("2026-07-01-edge-cache-a1b2");
    expect(note.frontmatter).not.toHaveProperty("intake");
    expect(noteIntake(note.frontmatter)).toBe("internal");
  });

  it("rejects a tier outside the two values rather than passing it through", () => {
    const bogus = PRE_ADR_NOTE.replace("created: 2026-07-01", "created: 2026-07-01\nintake: slack");
    expect(() => parseNote(bogus, "memory/2026-07-01-edge-cache-a1b2.md")).toThrow();
  });

  it("lets the trusted tier win over one smuggled in via `fields`", async () => {
    // `fields` is caller-supplied and spread FIRST in writeNote, so the derived keys must win —
    // the same injection guard as #77's id. A candidate must not be able to downgrade its own tier.
    const note = await writeNote(dir, {
      kind: "memory",
      title: "Productive ticket says the migration slips to Q4",
      body: "Ingested from the Productive ticket: the billing migration slips to Q4.",
      intake: "external",
      fields: { intake: "internal" },
    });
    expect(note.frontmatter.intake).toBe("external");
  });
});
