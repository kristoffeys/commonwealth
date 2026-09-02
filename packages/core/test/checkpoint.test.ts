import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkpointPath,
  confirmCheckpoint,
  fingerprintInputs,
  quietTick,
  readCheckpoint,
  recordCheckpoint,
} from "../src/checkpoint";
import { writeNote } from "../src/notes";
import { initBrain } from "../src/scaffold";

// Quiet-tick checkpoint primitive (#273): a cheap fingerprint of what a periodic pass reads, plus a
// marker that only ever advances after a successful pass.

let brainDir: string;

beforeEach(async () => {
  brainDir = await fs.mkdtemp(path.join(tmpdir(), "commonwealth-checkpoint-"));
  await initBrain(brainDir, { name: "t" });
});
afterEach(async () => {
  await fs.rm(brainDir, { recursive: true, force: true });
});

describe("fingerprintInputs (#273)", () => {
  it("is stable across repeated calls when nothing changed", async () => {
    await writeNote(brainDir, { kind: "memory", title: "A", body: "one" });
    const a = await fingerprintInputs({ trees: [brainDir] });
    const b = await fingerprintInputs({ trees: [brainDir] });
    expect(a).toBe(b);
  });

  it("changes when a note is added, and again when it is removed", async () => {
    const empty = await fingerprintInputs({ trees: [brainDir] });
    const note = await writeNote(brainDir, { kind: "memory", title: "A", body: "one" });
    const withNote = await fingerprintInputs({ trees: [brainDir] });
    expect(withNote).not.toBe(empty);

    await fs.rm(path.join(brainDir, note.path));
    // Back to the same file set ⇒ back to the same digest (the digest is a function of state).
    expect(await fingerprintInputs({ trees: [brainDir] })).toBe(empty);
  });

  it("changes on an in-place edit that keeps the same file set", async () => {
    const note = await writeNote(brainDir, { kind: "memory", title: "A", body: "one" });
    const before = await fingerprintInputs({ trees: [brainDir] });
    const abs = path.join(brainDir, note.path);
    await fs.writeFile(abs, (await fs.readFile(abs, "utf8")) + "\nan appended line\n", "utf8");
    expect(await fingerprintInputs({ trees: [brainDir] })).not.toBe(before);
  });

  it("ignores derived artifacts, so a regenerate/sync is not mistaken for a canon change", async () => {
    await writeNote(brainDir, { kind: "memory", title: "A", body: "one" });
    const before = await fingerprintInputs({ trees: [brainDir] });
    // COMMONWEALTH.md is regenerated on every sync; if it fed the digest the guard would never fire.
    await fs.writeFile(path.join(brainDir, "COMMONWEALTH.md"), "# regenerated\n", "utf8");
    expect(await fingerprintInputs({ trees: [brainDir] })).toBe(before);
  });

  it("folds pass parameters in, so a different threshold is never a quiet tick", async () => {
    await writeNote(brainDir, { kind: "memory", title: "A", body: "one" });
    const at90 = await fingerprintInputs({ trees: [brainDir], params: { threshold: 0.9 } });
    const at70 = await fingerprintInputs({ trees: [brainDir], params: { threshold: 0.7 } });
    expect(at70).not.toBe(at90);
    // Key ORDER must not matter — callers build the params object however they like.
    const one = await fingerprintInputs({ trees: [brainDir], params: { a: 1, b: 2 } });
    const two = await fingerprintInputs({ trees: [brainDir], params: { b: 2, a: 1 } });
    expect(one).toBe(two);
  });

  it("is insensitive to the order and duplication of the trees it is given", async () => {
    const other = await fs.mkdtemp(path.join(tmpdir(), "commonwealth-checkpoint-other-"));
    try {
      await initBrain(other, { name: "o" });
      await writeNote(other, { kind: "memory", title: "B", body: "two" });
      const ab = await fingerprintInputs({ trees: [brainDir, other] });
      const ba = await fingerprintInputs({ trees: [other, brainDir, other] });
      expect(ba).toBe(ab);
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });

  it("tracks the entry names of an opaque extra directory", async () => {
    const dir = path.join(brainDir, ".commonwealth", "graduation-tombstones");
    const before = await fingerprintInputs({ trees: [brainDir], dirs: [dir] });
    await fs.mkdir(dir, { recursive: true });
    // An absent dir hashes as empty, so creating it empty must not look like a change.
    expect(await fingerprintInputs({ trees: [brainDir], dirs: [dir] })).toBe(before);
    await fs.writeFile(path.join(dir, "abc.json"), "{}", "utf8");
    expect(await fingerprintInputs({ trees: [brainDir], dirs: [dir] })).not.toBe(before);
  });
});

describe("checkpoint storage (#273)", () => {
  it("lives inside the derived, gitignored index area", () => {
    expect(path.relative(brainDir, checkpointPath(brainDir, "consolidate"))).toBe(
      path.join("index", "checkpoints", "consolidate.json"),
    );
  });

  it("reads back what it recorded, and reads null when absent", async () => {
    expect(await readCheckpoint(brainDir, "consolidate")).toBeNull();
    await recordCheckpoint(brainDir, "consolidate", "deadbeef", Date.parse("2026-09-02T10:00:00Z"));
    const c = await readCheckpoint(brainDir, "consolidate");
    expect(c).toEqual({
      fingerprint: "deadbeef",
      ranAt: "2026-09-02T10:00:00.000Z",
      checkedAt: "2026-09-02T10:00:00.000Z",
    });
  });

  it("keeps each pass's checkpoint separate — one recording never affects the other", async () => {
    await recordCheckpoint(brainDir, "consolidate", "aaa", Date.now());
    expect(await readCheckpoint(brainDir, "graduate")).toBeNull();
    await recordCheckpoint(brainDir, "graduate", "bbb", Date.now());
    expect((await readCheckpoint(brainDir, "consolidate"))?.fingerprint).toBe("aaa");
    expect((await readCheckpoint(brainDir, "graduate"))?.fingerprint).toBe("bbb");
  });

  it("treats a corrupt or truncated checkpoint as absent (fail toward doing the work)", async () => {
    const file = checkpointPath(brainDir, "consolidate");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{not json", "utf8");
    expect(await readCheckpoint(brainDir, "consolidate")).toBeNull();
    await fs.writeFile(file, JSON.stringify({ fingerprint: "" }), "utf8");
    expect(await readCheckpoint(brainDir, "consolidate")).toBeNull();
  });

  it("confirmCheckpoint moves checkedAt but never ranAt, and no-ops when there is none", async () => {
    await confirmCheckpoint(brainDir, "consolidate", Date.now()); // nothing to refresh
    expect(await readCheckpoint(brainDir, "consolidate")).toBeNull();

    await recordCheckpoint(brainDir, "consolidate", "abc", Date.parse("2026-09-01T00:00:00Z"));
    await confirmCheckpoint(brainDir, "consolidate", Date.parse("2026-09-02T00:00:00Z"));
    expect(await readCheckpoint(brainDir, "consolidate")).toEqual({
      fingerprint: "abc",
      ranAt: "2026-09-01T00:00:00.000Z",
      checkedAt: "2026-09-02T00:00:00.000Z",
    });
  });
});

describe("quietTick (#273)", () => {
  it("reports changed on a cold start (no checkpoint ⇒ run the full pass)", async () => {
    await writeNote(brainDir, { kind: "memory", title: "A", body: "one" });
    const tick = await quietTick(brainDir, "consolidate", { trees: [brainDir] });
    expect(tick.unchanged).toBe(false);
    expect(tick.since).toBeUndefined();
    expect(tick.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports unchanged once a matching checkpoint exists, and changed again after an edit", async () => {
    await writeNote(brainDir, { kind: "memory", title: "A", body: "one" });
    const first = await quietTick(brainDir, "consolidate", { trees: [brainDir] });
    await recordCheckpoint(
      brainDir,
      "consolidate",
      first.fingerprint,
      Date.parse("2026-09-02T09:00:00Z"),
    );

    const second = await quietTick(brainDir, "consolidate", { trees: [brainDir] });
    expect(second.unchanged).toBe(true);
    expect(second.since).toBe("2026-09-02T09:00:00.000Z");

    await writeNote(brainDir, { kind: "memory", title: "B", body: "two" });
    expect((await quietTick(brainDir, "consolidate", { trees: [brainDir] })).unchanged).toBe(false);
  });

  it("reports changed when the index area was wiped, even if canon did not change", async () => {
    await writeNote(brainDir, { kind: "memory", title: "A", body: "one" });
    const tick = await quietTick(brainDir, "consolidate", { trees: [brainDir] });
    await recordCheckpoint(brainDir, "consolidate", tick.fingerprint, Date.now());
    expect((await quietTick(brainDir, "consolidate", { trees: [brainDir] })).unchanged).toBe(true);

    // A fresh clone / `rm -rf index/` — the checkpoint is disposable, so we simply do the work.
    await fs.rm(path.join(brainDir, "index"), { recursive: true, force: true });
    expect((await quietTick(brainDir, "consolidate", { trees: [brainDir] })).unchanged).toBe(false);
  });
});

describe("fingerprintInputs — explicit files (#273)", () => {
  it("tracks an individual non-note file, and distinguishes absent from present", async () => {
    const config = path.join(brainDir, ".commonwealth", "config.json");
    const withConfig = await fingerprintInputs({ trees: [brainDir], files: [config] });
    // A file listed but missing hashes distinctly, so it cannot collide with any real content.
    const missing = path.join(brainDir, ".commonwealth", "nope.json");
    expect(await fingerprintInputs({ trees: [brainDir], files: [missing] })).not.toBe(withConfig);

    // Editing the listed file moves the digest even though no note changed.
    await fs.writeFile(config, (await fs.readFile(config, "utf8")) + "\n", "utf8");
    expect(await fingerprintInputs({ trees: [brainDir], files: [config] })).not.toBe(withConfig);
  });

  it("does not let a listed file leak into the digest of a caller that omits it", async () => {
    const config = path.join(brainDir, ".commonwealth", "config.json");
    const bare = await fingerprintInputs({ trees: [brainDir] });
    expect(await fingerprintInputs({ trees: [brainDir], files: [config] })).not.toBe(bare);
    expect(await fingerprintInputs({ trees: [brainDir] })).toBe(bare);
  });
});

describe("checkpoint validation (#273)", () => {
  it("rejects a checkpoint with a blank ranAt (it would mute the quiet-tick report)", async () => {
    const file = checkpointPath(brainDir, "consolidate");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({ fingerprint: "abc", ranAt: "", checkedAt: "x" }),
      "utf8",
    );
    expect(await readCheckpoint(brainDir, "consolidate")).toBeNull();
    // …and therefore a tick over it is "changed", not a silently-mislabelled quiet tick.
    expect((await quietTick(brainDir, "consolidate", { trees: [brainDir] })).unchanged).toBe(false);
  });
});
