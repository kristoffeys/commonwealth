import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initBrain, regenerateDerived, writeNote } from "@cmnwlth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatVerifyRestore, runVerifyRestore, type VerifyRestoreEnv } from "../src/verify.js";

/**
 * `commonwealth verify-restore` orchestration (#136). The git/fs surfaces are injected: `clone`
 * materializes a real valid brain into the temp dir so `verifyBrain` runs for real, with no
 * network. The core `verifyBrain` checks themselves are covered in @cmnwlth/core's verify.test.ts.
 */
describe("runVerifyRestore", () => {
  let tmp: string;
  let brain: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cw-verify-cli-"));
    brain = path.join(tmp, "brain");
    await fs.mkdir(brain, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  /** A clone that builds a valid brain into `dest` (stands in for `git clone`). */
  async function cloneValidBrain(dest: string): Promise<boolean> {
    await initBrain(dest, { name: "restored" });
    await writeNote(dest, { kind: "memory", title: "A", body: "recovered fact" });
    await regenerateDerived(dest);
    return true;
  }

  function env(overrides: Partial<VerifyRestoreEnv> = {}): VerifyRestoreEnv {
    return {
      cwd: path.join(tmp, "project"),
      resolveBrain: () => Promise.resolve(brain),
      originUrl: () => "git@example.com:org/brain.git",
      clone: (_source, dest) => cloneValidBrain(dest),
      lastCommitISO: () => "2026-07-05T10:00:00Z",
      mkTemp: () => fs.mkdtemp(path.join(tmp, "clone-")),
      cleanup: (d) => fs.rm(d, { recursive: true, force: true }),
      now: () => new Date("2026-07-05T12:30:00Z"),
      ...overrides,
    };
  }

  it("verifies a clean restore from the committed state and computes an RPO", async () => {
    const report = await runVerifyRestore({ fromRemote: false }, env());
    expect(report.ok).toBe(true);
    expect(report.cloned).toBe(true);
    expect(report.source).toBe(brain); // local repo, not the remote
    expect(report.rpo).toBe("2h 30m"); // 10:00 → 12:30
    expect(report.result?.noteCount).toBe(1);
  });

  it("clones the origin remote under --from-remote", async () => {
    let clonedSource: string | null = null;
    const report = await runVerifyRestore(
      { fromRemote: true },
      env({
        clone: (source, dest) => {
          clonedSource = source;
          return cloneValidBrain(dest);
        },
      }),
    );
    expect(clonedSource).toBe("git@example.com:org/brain.git");
    expect(report.fromRemote).toBe(true);
    expect(report.ok).toBe(true);
  });

  it("throws when --from-remote is used but the brain has no origin", async () => {
    await expect(
      runVerifyRestore({ fromRemote: true }, env({ originUrl: () => null })),
    ).rejects.toThrow(/no `origin` remote/);
  });

  it("reports a failed clone as a failed restore", async () => {
    const report = await runVerifyRestore(
      { fromRemote: false },
      env({ clone: () => Promise.resolve(false) }),
    );
    expect(report.cloned).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.result).toBeNull();
    expect(formatVerifyRestore(report)).toContain("Clone failed");
  });

  it("throws when no brain resolves", async () => {
    await expect(
      runVerifyRestore({ fromRemote: false }, env({ resolveBrain: () => Promise.resolve(null) })),
    ).rejects.toThrow(/No Commonwealth brain/);
  });

  it("renders the proof with an RPO line and per-check marks", async () => {
    const report = await runVerifyRestore({ fromRemote: false }, env());
    const text = formatVerifyRestore(report);
    expect(text).toContain("verify-restore");
    expect(text).toContain("RPO:");
    expect(text).toContain("Restore verified");
  });
});
