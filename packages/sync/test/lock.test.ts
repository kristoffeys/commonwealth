import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireSyncLock } from "../src/lock";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "commonwealth-lock-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const lockFile = (): string => path.join(dir, ".commonwealth", "sync.lock");

describe("acquireSyncLock (#100)", () => {
  it("grants the lock, blocks a second acquire while held, and re-grants after release", async () => {
    const release = await acquireSyncLock(dir);
    expect(release).toBeTypeOf("function");

    // While held (by this live process), a second acquire is refused.
    expect(await acquireSyncLock(dir)).toBeNull();

    await release!();
    // Released → available again.
    const again = await acquireSyncLock(dir);
    expect(again).toBeTypeOf("function");
    await again!();
  });

  it("reclaims a stale lock whose owner process is dead", async () => {
    await fs.mkdir(path.dirname(lockFile()), { recursive: true });
    // A pid that is essentially guaranteed not to be a live process.
    await fs.writeFile(lockFile(), `${2 ** 30}\n`, "utf8");

    const release = await acquireSyncLock(dir);
    expect(release).toBeTypeOf("function"); // stale lock stolen, not blocked
    // The lock file now records THIS process.
    expect((await fs.readFile(lockFile(), "utf8")).trim()).toBe(String(process.pid));
    await release!();
    await expect(fs.access(lockFile())).rejects.toBeTruthy(); // release removes it
  });

  it("reclaims a lock with garbage contents", async () => {
    await fs.mkdir(path.dirname(lockFile()), { recursive: true });
    await fs.writeFile(lockFile(), "not-a-pid\n", "utf8");
    const release = await acquireSyncLock(dir);
    expect(release).toBeTypeOf("function");
    await release!();
  });
});
