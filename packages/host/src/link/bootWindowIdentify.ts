/**
 * bootWindowIdentify.ts — the `HELLO` boot-window resend schedule,
 * extracted from `watchers/usbWatcher.ts` (ticket 015-001) so
 * `connect/connector.ts` does not reimplement it: both modules need to
 * cover the macOS boot window (a `HELLO` sent while the board is still
 * resetting is dropped outright — waiting longer for a reply to *that*
 * send never helps, only sending again after the boot window has
 * passed does) and, before this ticket, only `usbWatcher.ts` had this
 * logic, written as a private closure over its own `link`/`scheduler`.
 *
 * No behavior change from `usbWatcher.ts`'s original inline version —
 * see that module's own doc comment ("The stubbed connector call") for
 * the full rationale, and `docs/reviews/2026-09-11/01-host-device-model.md`
 * §2.1 / `02-host-transport.md` §5 item 4 for the boot-window problem
 * this schedule fixes.
 */
import type { ParsedBanner } from "@robot-console/protocol";
import type { LineLink } from "./LineLink.js";
import type { Scheduler } from "./pacing.js";

/** `HELLO` resend offsets, in ms from the moment `LineLink.connect()`
 * resolves. */
export const DEFAULT_IDENTIFY_SCHEDULE_MS: readonly number[] = [0, 750, 1500, 2500];
/** Total budget for the whole boot-window identify sequence — passed as
 * the link's own `identifyTimeoutMs` by callers of {@link
 * identifyWithBootWindowRetry}. */
export const DEFAULT_IDENTIFY_BUDGET_MS = 4000;

/** Resend the `HELLO` line without re-invoking `LineLink.identify()`
 * itself: a second `identify()` call while the first is still pending
 * would share that same wait rather than send anything new (see
 * `LineLink.identify()`'s own doc comment), so the resend goes through
 * `link.session.connect()` (the only sanctioned way to format `HELLO` —
 * safe to call again here since nothing is in flight on this session
 * yet, per `Session.connect()`'s own doc comment) plus `link.sendLine()`.
 * Whichever `HELLO` a banner reply actually answers, `LineLink`'s
 * already-pending banner wait (armed by the one `identify()` call in
 * {@link identifyWithBootWindowRetry}) catches it. */
export function resendHello(link: LineLink): void {
  const line = link.session.connect();
  link.sendLine(line);
}

/**
 * Send `HELLO` (via the one sanctioned {@link LineLink.identify} call)
 * and, in parallel, resend it at `schedule`'s later offsets until a
 * banner arrives or `identify()`'s own internal budget expires —
 * covering the boot window per this module's own doc comment. Every
 * resend checks `link.isOpen` first, so a meanwhile-closed link is
 * never written to.
 */
export async function identifyWithBootWindowRetry(
  link: LineLink,
  schedule: readonly number[],
  scheduler: Scheduler,
): Promise<ParsedBanner | null> {
  let settled = false;
  const identifyPromise = link.identify().then((banner) => {
    settled = true;
    return banner;
  });

  void (async () => {
    let previousOffset = schedule[0] ?? 0;
    for (const offset of schedule.slice(1)) {
      const gap = offset - previousOffset;
      previousOffset = offset;
      if (gap > 0) {
        await scheduler.delay(gap);
      }
      if (settled || !link.isOpen) {
        return;
      }
      resendHello(link);
    }
  })();

  return identifyPromise;
}
