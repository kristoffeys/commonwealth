import { describe, expect, it } from "vitest";
import { SerialQueue } from "../src/queue";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("SerialQueue", () => {
  it("runs tasks strictly one-at-a-time (no interleaving)", async () => {
    const queue = new SerialQueue();
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;

    const task = (id: number) => async (): Promise<void> => {
      active++;
      maxActive = Math.max(maxActive, active);
      events.push(`start-${id}`);
      // Randomized work so a broken (parallel) queue would interleave.
      await sleep(id % 2 === 0 ? 10 : 3);
      events.push(`stop-${id}`);
      active--;
    };

    // Fire five overlapping enqueues without awaiting between them.
    await Promise.all([1, 2, 3, 4, 5].map((id) => queue.enqueue(task(id))));

    // Never more than one running concurrently.
    expect(maxActive).toBe(1);
    // Each task's start is immediately followed by its own stop, in enqueue order.
    expect(events).toEqual([
      "start-1",
      "stop-1",
      "start-2",
      "stop-2",
      "start-3",
      "stop-3",
      "start-4",
      "stop-4",
      "start-5",
      "stop-5",
    ]);
  });

  it("returns each task's result and isolates rejections", async () => {
    const queue = new SerialQueue();
    const ok = queue.enqueue(async () => 42);
    const bad = queue.enqueue(async () => {
      throw new Error("boom");
    });
    const after = queue.enqueue(async () => "still runs");

    await expect(ok).resolves.toBe(42);
    await expect(bad).rejects.toThrow("boom");
    await expect(after).resolves.toBe("still runs");
  });
});
