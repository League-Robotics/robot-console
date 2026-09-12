/**
 * pacing.ts — serializes writes to a transport so consecutive writes
 * are separated by a minimum gap. Transport-agnostic: every link
 * (USB serial this sprint; relay/TCP/UDP in sprint 7) paces its writes
 * through the same {@link WritePacer} — writing flat out overruns the
 * board's USB receive buffer, and the radio side this eventually
 * bridges to is far slower than any of these transports, so every
 * write (the initial `HELLO` included, not just steady-state traffic)
 * goes through the same pacer. Moved verbatim out of `UsbSerialLink.ts`
 * (sprint 4 ticket 002) — no behavior change.
 */

/** Injectable delay primitive so write-pacing timing is unit-testable
 * without real wall-clock waits. Real usage defaults to {@link
 * realScheduler}; tests substitute a fake that records/controls delay
 * calls directly. */
export interface Scheduler {
  delay(ms: number): Promise<void>;
}

export const realScheduler: Scheduler = {
  delay: (ms: number) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

/**
 * Serializes writes through a single chain so that every write this
 * module makes is separated from the next by at least `paceMs`.
 * Implemented as a promise chain rather than a timer-driven queue so
 * that back-to-back `schedule()` calls compose correctly regardless of
 * how many are already pending.
 */
export class WritePacer {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly paceMs: number,
    private readonly scheduler: Scheduler = realScheduler,
  ) {}

  /**
   * Enqueue `write` to run once every previously-scheduled write (and
   * its trailing pace delay) has completed. `write` may be synchronous
   * (the four old link classes' usage: a bare callback with no return
   * value) or return a `Promise` that settles once an async write
   * (e.g. a callback-style socket/port write wrapped in a `Promise`)
   * completes — either shape is paced identically.
   *
   * A throwing/rejecting `write` does not wedge later writes: the
   * chain always continues. Without an `onError` callback the failure
   * is swallowed exactly as before (the four old link classes' own
   * `paceWrite` passes none, matching `pacing.ts`'s historical
   * "there is no caller to report it to" posture). A caller that DOES
   * want to know (`LineLink`, ticket 014-005 — review
   * `02-host-transport.md` §5.8/§6: "write failures are invisible ...
   * have `schedule()` accept an async write and report failures via a
   * callback instead of swallowing") passes `onError`, invoked with the
   * failure instead of it vanishing silently.
   */
  schedule(write: () => void | Promise<void>, onError?: (err: Error) => void): void {
    this.chain = this.chain
      .then(() => write())
      .then(() => this.scheduler.delay(this.paceMs))
      .catch((err: unknown) => {
        onError?.(err instanceof Error ? err : new Error(String(err)));
      });
  }
}
