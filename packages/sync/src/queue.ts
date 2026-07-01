/**
 * A strict FIFO async mutex. Every task passed to {@link SerialQueue.enqueue} runs
 * to completion (or rejection) before the next one starts, so overlapping callers can
 * never interleave. This is the sync write queue (issue #7): ALL git mutations funnel
 * through one instance so concurrent triggers (watcher, poll, CLI) never race.
 */
export class SerialQueue {
  /** Tail of the promise chain; each enqueue appends to it. */
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Run `fn` after every previously-enqueued task has settled. Returns a promise for
   * `fn`'s result. A rejection in one task does not break the chain — later tasks still
   * run — but it is propagated to that task's own caller.
   */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    // Chain onto the current tail, swallowing prior errors so the chain never wedges.
    const run = this.tail.then(() => fn());
    // Advance the tail to this task's settlement, ignoring its outcome for chaining.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
