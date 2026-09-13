/**
 * withTimeout.ts — a small, dependency-free helper that races an async
 * operation against a deadline timer. Sprint 017 ticket 003 (issue
 * `rearch-14-flash-swd-timeouts-platform-msd-fallback.md`): no
 * `dapjs`/`node-hid` call in `flash.ts` or `swdName.ts` had a timeout, so
 * a wedged HID transport (a real bench failure mode, not a theoretical
 * one -- see that issue's Description) hung the board's `board_owner`
 * slot forever with no escape. This module is the one place that bound
 * is implemented, shared by both call sites rather than duplicated,
 * since `swdName.ts` must not depend on `flash.ts` (or vice versa) just
 * to reuse it.
 */

/**
 * Thrown (caught at every call site in this codebase, never left to
 * bubble uncaught) when the raced promise does not settle within `ms`
 * milliseconds. A distinct class -- not a plain `Error` -- so a caller
 * can `instanceof`-check it to classify a timeout as its own typed
 * failure reason, the same "typed, not string-matched" precedent
 * `FlashFailure.reason`/`SwdNameFailure.reason` already set.
 */
export class TimeoutError extends Error {
  readonly label: string;
  readonly ms: number;

  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "TimeoutError";
    this.label = label;
    this.ms = ms;
  }
}

/**
 * Races `promise` against a `ms`-millisecond timer labeled `label` (used
 * only in the resulting {@link TimeoutError}'s message, for
 * diagnostics/logging). Resolves or rejects with whatever `promise`
 * itself settles with if it wins the race; rejects with a
 * {@link TimeoutError} if the timer fires first. The timer is always
 * cleared once `promise` settles, whichever happens first, and is
 * `unref()`'d so a pending call never keeps the process alive on its
 * own -- matching every other timer in this codebase.
 *
 * Deliberately does **not** cancel or abort `promise` itself -- `dapjs`
 * gives no cancellation seam for an in-flight HID transfer, so a caller
 * that times out here must still disconnect the transport itself
 * (best-effort) to reclaim the handle; see `flash.ts`'s and
 * `swdName.ts`'s own call sites for that cleanup.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
