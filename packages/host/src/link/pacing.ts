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

  /** Enqueue `write` to run once every previously-scheduled write (and
   * its trailing pace delay) has completed. A throwing `write` does not
   * wedge later writes — the failure is swallowed here (there is no
   * caller to report it to; this is fire-and-forget queuing) and the
   * chain continues. */
  schedule(write: () => void): void {
    this.chain = this.chain
      .then(() => {
        write();
      })
      .then(() => this.scheduler.delay(this.paceMs))
      .catch(() => {
        // Swallow: one bad write must not stall every later paced write.
      });
  }
}
