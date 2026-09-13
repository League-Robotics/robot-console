/**
 * usbWatcher.ts — keep `devices`/`links(usb)` rows current for whatever
 * is enumerated on USB right now (ticket 014-007 / issue
 * `rearch-02-usb-watcher-writes-rows-one-identify-per-attach.md`;
 * `docs/design/architecture.md` §6.1). Sits on top of `devices.ts`'s
 * `DeviceWatcher`/`diffDaplinkDevices` (unchanged enumerator, now
 * `updated`-aware — see that module's own doc comment) and writes
 * through the `store/` module's typed operations only — never raw SQL
 * (architecture.md §3 rule 3).
 *
 * ## Per-poll flow
 *
 * - **`added`**: take `board_owner = 'naming'` for the board's USB
 *   serial, read its SWD name with a timeout (`swdName.ts`'s
 *   `readSwdName`, which never rejects on its own but is not itself
 *   bounded — this module adds the timeout), upsert `devices` (if
 *   named) and `links(usb, discovered)`, release the owner. This upsert
 *   never asserts or overwrites `kind` (018-004: a chip id read cannot
 *   itself tell a robot from a relay apart — see `store/index.ts`'s own
 *   "kind is never guessed" doc comment); a device already known to be
 *   a relay is also skipped for the placeholder merge below. A named
 *   device that is not already known as a relay also merges any
 *   `known-robots.json` placeholder sharing its name
 *   (`store/placeholderMerge.ts`'s `mergeNamePlaceholderIfAny`,
 *   bench defect 010, 2026-09-13 — SWD naming is trustworthy identity
 *   the instant it succeeds, so this must not wait on a later banner
 *   identify that a flaky cable may never produce cleanly). Sprint 015
 *   ticket 003: this watcher writes rows only and stops here — it no
 *   longer opens a `LineLink` or sends `HELLO` itself (see "Watchers
 *   write rows only" below). If SWD naming identified the board, the
 *   link is marked `connectable` so `connect/reconciler.ts`'s `plan()`
 *   schedules the actual connect through `connect/connector.ts`.
 * - **`updated`**: patch the link's `address` only, then — only for a
 *   link still sitting `discovered` (never `connected`/`connecting`/
 *   `failed`/`unresponsive`/`closed_by_user`/`stale`) whose new address
 *   now has a serial `path` — either mark it `connectable` (it was
 *   already named at `added` time; the serial port was simply the last
 *   piece to arrive) or, if it was never named *and* its `added`-time
 *   address had no path either, give naming one more try via `attach()`
 *   itself (bench defect 010, 2026-09-13; see `attach()`'s own doc
 *   comment for why this is safe and `handleUpdated`'s for the exact
 *   gate). A naming failure for any other reason is still never
 *   retried — the whole point of `diffDaplinkDevices` reporting this as
 *   `updated` rather than remove+add is that a *content* change alone
 *   must never repeat a completed SWD read.
 * - **`removed`**: mark the link `stale`, close any open `sessions` row
 *   for it (bench defect 010 addendum, 2026-09-13 -- see `handleRemoved`'s
 *   own doc comment), release any `board_owner` row, abort any in-flight
 *   attach task for that serial.
 *
 * Every poll also heartbeats a `tasks` row (`architecture.md` §3 rule
 * 5), so a wedged watcher is visible without the UI.
 *
 * ## Watchers write rows only (sprint 015 ticket 003)
 *
 * Through sprint 014, `attach()` below (via the now-deleted
 * `connectWithRetry`) opened a `LineLink` and ran the full boot-window
 * `HELLO` identify itself — a deliberate, called-out stand-in for "the
 * reconciler decided to connect", since the reconciler did not exist
 * yet. Sprint 015's `connect/reconciler.ts`
 * (ticket 002) plus `connect/connector.ts` (ticket 001) now own that
 * entirely: this watcher's only remaining job per architecture.md §6.1
 * is "write `devices`/`links(usb, discovered)` rows, release the
 * owner. The reconciler does the rest" — marking a link `connectable`
 * once it is safe to schedule, never dialing the transport itself.
 *
 * ## SWD naming failure is still a dead end for automatic connect
 *
 * `connect/reconciler.ts`'s `plan()` only ever considers a link whose
 * `device_id` is already known (it groups auto-connect candidates per
 * device) — so a board whose SWD read fails for a reason unrelated to a
 * missing serial path (permission, timeout, an unsupported/locked chip)
 * is left `discovered` forever, with no retry: `handleUpdated` (see
 * below) only ever gives naming a second try when the *first* attempt
 * had no serial path to offer either, on the theory that "no path yet"
 * is the one specific precondition this module can later observe
 * change. A future ticket may want the connector's own banner-based
 * identify to be reachable without a prior SWD-derived `device_id` (the
 * old registry's own `defaultLinkFactory` path did not require one
 * either) — out of scope here.
 *
 * ## Injectable seams
 *
 * Every external effect is injectable via {@link UsbWatcherDeps}, so
 * this module is fully unit-testable against `devices.ts`'s own fixture
 * conventions — no real `serialport`/`node-hid`/SWD I/O anywhere.
 */
import {
  diffDaplinkDevices,
  enumerateDaplinkDevices,
  type DaplinkDevice,
  type DaplinkDeviceLister,
} from "../devices.js";
import { readSwdName as defaultReadSwdName, type CortexMFactory, type SwdNameResult } from "../swdName.js";
import { Store } from "../store/index.js";
import { mergeNamePlaceholderIfAny } from "../store/placeholderMerge.js";

const DEFAULT_POLL_INTERVAL_MS = 1000;
/** Bound on `readSwdName` — that function never rejects on its own
 * (see its own doc comment), but nothing bounds how long a stuck
 * HID/SWD attach can take without this. */
const DEFAULT_NAME_TIMEOUT_MS = 2000;
/** `board_owner.owner` token this watcher takes while reading a board's
 * SWD name — architecture.md §4's `board_owner` table. */
const NAMING_OWNER = "naming";
/** `tasks.name` this watcher heartbeats every poll. */
const TASK_NAME = "usbWatcher";

/** Stable `links.id` for a USB device, derived from the DAPLink
 * interface chip's own USB serial number (the join key that survives a
 * replug — see `devices.ts`'s own module doc comment). */
function usbLinkId(serialNumber: string): string {
  return `usb-${serialNumber}`;
}

/** `links.address` shape for a `usb` transport (architecture.md §4:
 * `{path,hidPath}`). */
function usbLinkAddress(device: DaplinkDevice): { path: string | undefined; hidPath: string | undefined } {
  return { path: device.serialPort?.path, hidPath: device.hid?.path };
}

/** Race `promise` against `ms`; on timeout, resolve with `onTimeout()`'s
 * value instead of leaving the caller hanging. `readSwdName` itself
 * never rejects, but this still guards the `.then` path defensively. */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(onTimeout());
      }
    }, ms);
    promise.then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(onTimeout());
        }
      },
    );
  });
}

/** Injectable seams — real implementations by default; fakes in tests.
 * Named to match the ticket's own "enumerator/SWD-namer/clock"
 * framing. */
export interface UsbWatcherDeps {
  /** The enumerator ("enumerator"). Defaults to
   * {@link enumerateDaplinkDevices}. */
  listDevices?: DaplinkDeviceLister;
  /** The SWD namer. Defaults to `swdName.ts`'s {@link defaultReadSwdName}. */
  readSwdName?: (
    device: DaplinkDevice,
    options?: { createCortexM?: CortexMFactory },
  ) => Promise<SwdNameResult>;
  /** Wall-clock reader for every store timestamp. Defaults to
   * `Date.now`. */
  now?: () => number;
}

export interface UsbWatcherOptions {
  /** Poll interval in ms. Defaults to 1000. */
  pollIntervalMs?: number;
  /** Bound on the SWD name read. Defaults to 2000. */
  nameTimeoutMs?: number;
}

export interface UsbWatcherHandle {
  /** Stop polling and abort every in-flight attach task. Idempotent. */
  stop(): void;
}

/**
 * Start the USB watcher against `store`. See the module doc comment for
 * the per-poll flow. Returns a handle whose `stop()` tears everything
 * down — there is no other way to stop this task (architecture.md §3
 * rule 5: every long-lived task has `start()`/`stop()`).
 */
export function startUsbWatcher(
  store: Store,
  deps: UsbWatcherDeps = {},
  opts: UsbWatcherOptions = {},
): UsbWatcherHandle {
  const listDevices = deps.listDevices ?? enumerateDaplinkDevices;
  const readSwdNameFn = deps.readSwdName ?? defaultReadSwdName;
  const now = deps.now ?? (() => Date.now());

  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const nameTimeoutMs = opts.nameTimeoutMs ?? DEFAULT_NAME_TIMEOUT_MS;

  let currentDevices: DaplinkDevice[] = [];
  /** In-flight attach tasks, keyed by USB serial number, so a `removed`
   * event can cancel one before it writes any more rows for a board
   * that is no longer there. */
  const attachTasks = new Map<string, AbortController>();
  let stopped = false;

  function forgetTask(serialNumber: string, controller: AbortController): void {
    if (attachTasks.get(serialNumber) === controller) {
      attachTasks.delete(serialNumber);
    }
  }

  /** The whole per-attach flow for one newly-`added` device: SWD naming
   * under `board_owner = 'naming'`, then (if named) marking the link
   * `connectable` for the reconciler. See the module doc comment. */
  async function attach(device: DaplinkDevice, signal: AbortSignal): Promise<void> {
    const linkId = usbLinkId(device.serialNumber);
    const address = usbLinkAddress(device);

    store.acquireBoardOwner(device.serialNumber, NAMING_OWNER, now());
    let namedDeviceId: number | undefined;
    try {
      const swdResult = await withTimeout(
        readSwdNameFn(device),
        nameTimeoutMs,
        (): SwdNameResult => ({
          status: "unnamed",
          reason: "attach-failed",
          error: `SWD naming timed out after ${nameTimeoutMs}ms`,
        }),
      );

      if (swdResult.status === "named") {
        namedDeviceId = swdResult.deviceId;
        // 018-004: a chip id read over the debug interface cannot itself
        // tell a robot from a relay apart (both expose the same SWD/DAP
        // interface) -- `kind` is deliberately omitted here so this
        // upsert never asserts or overwrites it. A pre-existing row (a
        // relay already identified by a banner, e.g. `mdnsWatcher.ts`'s
        // own relay discovery) keeps its own `kind` unchanged; only a
        // genuinely brand-new row gets the store's own required-column
        // default. See `store/index.ts`'s own "kind is never guessed"
        // doc comment for the full mechanism this replaces (the previous
        // unconditional `kind: "robot"` here silently downgraded a known
        // relay, `vevav`, the instant it was next seen over USB).
        const existingKind = store.getDeviceKind(swdResult.deviceId);
        store.upsertDevice({
          id: swdResult.deviceId,
          name: swdResult.name,
          usbSerial: device.serialNumber,
          at: now(),
        });
        // Bench defect 010 (2026-09-13): "the same robot appears twice".
        // SWD naming (a chip id read directly over the debug interface)
        // is trustworthy identity the instant it succeeds -- unlike a
        // banner identify, it never gets a second chance to be corrupted
        // by a flaky serial cable, so it must not wait for one to merge a
        // `known-robots.json` placeholder. `connect/connector.ts`'s own
        // merge (after a successful banner identify) is not enough on its
        // own: a board whose cable never once produces a clean banner
        // (the exact `tovez` bench case) would otherwise stay a
        // duplicate row forever. See `store/placeholderMerge.ts`'s own
        // doc comment for the shared helper and why it lives there.
        //
        // 018-004: never run this merge for a device already known to be
        // a relay -- `known-robots.json` never seeds a relay placeholder
        // in the first place, so this is defensive, but a relay's own
        // name must never become eligible for a robot-placeholder merge
        // on the strength of a name match alone.
        if (existingKind !== "relay") {
          mergeNamePlaceholderIfAny(store, swdResult.name, swdResult.deviceId, now());
        }
      }
      store.upsertLink({
        id: linkId,
        transport: "usb",
        address,
        deviceId: namedDeviceId ?? null,
        at: now(),
      });
    } finally {
      store.releaseBoardOwner(device.serialNumber, NAMING_OWNER);
    }

    if (signal.aborted || namedDeviceId === undefined || address.path === undefined) {
      // Either the board is already gone, SWD naming did not identify it
      // (see the module doc comment's own "still a dead end" section),
      // or this attach is HID-only (no serial port yet) -- nothing the
      // reconciler could connect to yet either way. A later poll reports
      // the serial port's arrival as `updated`, not a fresh `added`, so
      // this exact call never gets a second chance to mark this link
      // `connectable` -- but bench defect 010 (2026-09-13) found the link
      // then stayed `discovered` indefinitely, since nothing else ever
      // revisited it either. `handleUpdated` below now does: once the
      // serial path arrives, it promotes an already-named link straight
      // to `connectable`, or -- if naming had nothing to go on the first
      // time either (no path yet) -- calls this same `attach()` again for
      // one more try.
      return;
    }

    store.setLinkState({ id: linkId, state: "connectable", at: now() });
  }

  function handleAdded(device: DaplinkDevice): void {
    const controller = new AbortController();
    attachTasks.set(device.serialNumber, controller);
    void attach(device, controller.signal)
      .catch(() => {
        // A failed attach must not take down the poll loop over one
        // board -- an unnamed board simply stays `discovered`; anything
        // else (a thrown SWD/enumerator surprise) is swallowed here
        // rather than crashing the watcher.
      })
      .finally(() => forgetTask(device.serialNumber, controller));
  }

  /**
   * Bench defect 010 (2026-09-13): a USB robot plugged in while the host
   * runs never auto-connected. `attach()` bails without marking the link
   * `connectable` whenever the board's serial port has not yet enumerated
   * (`address.path === undefined` — DAPLink's HID interface commonly
   * finishes enumerating first). The serial port's later arrival was
   * only ever reported here as `updated`, which used to patch `address`
   * and stop — so a link that was already fully named at `added` time sat
   * `discovered` forever, with nothing left to ever revisit it (observed
   * live: a board's link stuck `discovered` for 5+ minutes, while
   * clicking Connect by hand worked in under a second). Fixed here:
   * once the new address has a serial path and the link is still
   * `discovered` (never `connected`/`connecting`/`failed`/`unresponsive`/
   * `closed_by_user`/`stale` — those are somebody else's business), a
   * link that was already named just needed the path and is promoted
   * straight to `connectable`; a link that was never named *and* whose
   * `added`-time address had no path either gets one more naming try via
   * `attach()` itself (reused, not duplicated) — see that function's own
   * doc comment. A naming failure for any other reason is still never
   * retried, matching the module doc's "still a dead end" section.
   */
  function handleUpdated(device: DaplinkDevice): void {
    const linkId = usbLinkId(device.serialNumber);
    const existing = store.reconcilerRows().links.find((link) => link.id === linkId);

    store.upsertLink({
      id: linkId,
      transport: "usb",
      address: usbLinkAddress(device),
      at: now(),
    });

    if (!existing || existing.state !== "discovered" || attachTasks.has(device.serialNumber)) {
      // Nothing to reconsider: no prior row, a state this handler must
      // never touch, or an `attach()` already in flight for this serial
      // (let it finish rather than racing a second SWD read/board_owner
      // claim against itself).
      return;
    }

    const address = usbLinkAddress(device);
    if (address.path === undefined) {
      // Still no serial port -- nothing new for the reconciler yet.
      return;
    }

    if (existing.deviceId != null) {
      // Already named at `added` time; the serial path was the only
      // thing missing. Safe for the reconciler's next tick to connect.
      store.setLinkState({ id: linkId, state: "connectable", at: now() });
      return;
    }

    const existingAddress = existing.address as { path?: string } | null | undefined;
    if (existingAddress?.path === undefined) {
      // Never named, and the earlier attach had no serial path to offer
      // either -- give naming one more try now that one has appeared.
      // If it fails again (for any reason), this link simply falls back
      // to the module doc's "still a dead end" behavior; it is not
      // retried a third time from here.
      handleAdded(device);
    }
  }

  function handleRemoved(device: DaplinkDevice): void {
    attachTasks.get(device.serialNumber)?.abort();
    attachTasks.delete(device.serialNumber);

    const linkId = usbLinkId(device.serialNumber);
    store.setLinkState({ id: linkId, state: "stale", at: now() });
    // Bench defect 010 addendum (2026-09-13, "dead transport leaves
    // session, blocks reconnect"): architecture.md §6.1's own "On
    // remove: mark the link stale, close any session, release owners"
    // -- the close-any-session half was missing here, so a `sessions`
    // row (and, transitively, `connect/reconciler.ts`'s own `plan()`/
    // `describeUserOpenRefusal` treating the device as still open)
    // outlived a board that had already physically disappeared, until
    // whatever eventually noticed the dead transport on its own (the
    // harvester's slower missed-poll watchdog) got around to it.
    // `store.closeSession` is a plain, idempotent DELETE -- safe to call
    // whether or not a session was actually open -- and this executor
    // holds no live `LineLink` of its own to close directly (only
    // `connect/reconciler.ts`'s private `sessions` map does; it reaps
    // its own local reference once the row disappears out from under it,
    // via its own dead-transport cleanup -- see that module's doc
    // comment). This is exactly "a store change the reconciler reacts
    // to" (`store.onChange` already re-runs `plan()` on every write).
    store.closeSession(linkId);
    store.releaseBoardOwner(device.serialNumber, NAMING_OWNER);
  }

  async function pollOnce(): Promise<void> {
    const next = await listDevices();
    // Opt into the `updated` bucket (ticket 014-010): this watcher is
    // the consumer `diffDaplinkDevices`'s `updated` behaviour was built
    // for (ticket 014-007) -- refresh address, keep everything else
    // unchanged, never re-run SWD naming.
    const { added, removed, updated } = diffDaplinkDevices(currentDevices, next, {
      reportUpdatedInPlace: true,
    });
    currentDevices = next;

    for (const device of removed) {
      handleRemoved(device);
    }
    for (const device of updated) {
      handleUpdated(device);
    }
    for (const device of added) {
      handleAdded(device);
    }

    store.heartbeat(TASK_NAME, now());
  }

  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    void pollOnce();
  }, pollIntervalMs);
  timer.unref?.();

  return {
    stop(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
      for (const controller of attachTasks.values()) {
        controller.abort();
      }
      attachTasks.clear();
    },
  };
}
