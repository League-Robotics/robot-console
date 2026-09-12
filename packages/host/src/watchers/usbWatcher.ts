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
 *   named) and `links(usb, discovered)`, release the owner. Sprint 015
 *   ticket 003: this watcher writes rows only and stops here — it no
 *   longer opens a `LineLink` or sends `HELLO` itself (see "Watchers
 *   write rows only" below). If SWD naming identified the board, the
 *   link is marked `connectable` so `connect/reconciler.ts`'s `plan()`
 *   schedules the actual connect through `connect/connector.ts`.
 * - **`updated`**: patch the link's `address` only. Never re-runs SWD
 *   naming — the whole point of `diffDaplinkDevices` reporting this as
 *   `updated` rather than remove+add.
 * - **`removed`**: mark the link `stale`, release any `board_owner` row,
 *   abort any in-flight attach task for that serial.
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
 * device) — this was already true before this ticket, so a board whose
 * SWD read fails (`namedDeviceId` stays `undefined`) is left `discovered`
 * rather than `connectable`, exactly like the pre-ticket code's own
 * "this watcher never gets a second chance to identify this board
 * through this code path (by design)" limitation for a HID-only attach
 * whose serial port never arrives. A future ticket may want the
 * connector's own banner-based identify to be reachable without a prior
 * SWD-derived `device_id` (the old registry's own `defaultLinkFactory`
 * path did not require one either) — out of scope here.
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
        store.upsertDevice({
          id: swdResult.deviceId,
          name: swdResult.name,
          kind: "robot",
          usbSerial: device.serialNumber,
          at: now(),
        });
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
      // this watcher never gets a second chance to mark this link
      // `connectable` through this code path (by design, unchanged from
      // the pre-ticket behavior).
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

  function handleUpdated(device: DaplinkDevice): void {
    store.upsertLink({
      id: usbLinkId(device.serialNumber),
      transport: "usb",
      address: usbLinkAddress(device),
      at: now(),
    });
  }

  function handleRemoved(device: DaplinkDevice): void {
    attachTasks.get(device.serialNumber)?.abort();
    attachTasks.delete(device.serialNumber);

    store.setLinkState({ id: usbLinkId(device.serialNumber), state: "stale", at: now() });
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
