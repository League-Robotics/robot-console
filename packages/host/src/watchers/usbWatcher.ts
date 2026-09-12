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
 *   named) and `links(usb, discovered)`, release the owner. Then —
 *   still as part of the same attach, per `sprint.md`'s Design
 *   Rationale ("watchers stub the connector call directly instead of
 *   waiting for the reconciler") — connect and identify directly
 *   through `LineLink`, covering the macOS boot window with a resend
 *   schedule rather than one long single wait (a `HELLO` sent while the
 *   board is still resetting is dropped outright; waiting longer for a
 *   reply to *that* send never helps — only sending again after the
 *   boot window has passed does). A banner classifies the device
 *   (`@robot-console/protocol`'s `classifyBanner`) and, for a robot,
 *   sets `devices.owned = 1`.
 * - **`updated`**: patch the link's `address` only. Never re-runs SWD
 *   naming or identify — the whole point of `diffDaplinkDevices`
 *   reporting this as `updated` rather than remove+add.
 * - **`removed`**: mark the link `stale`, release any `board_owner` row,
 *   abort any in-flight attach task for that serial, and close any open
 *   `LineLink` this watcher is still holding for it.
 *
 * Every poll also heartbeats a `tasks` row (`architecture.md` §3 rule
 * 5), so a wedged watcher is visible without the UI.
 *
 * ## The stubbed connector call (`TODO(rearch-05)`)
 *
 * `connectWithRetry`/`identifyWithBootWindowRetry` below are a
 * deliberate, called-out stand-in for "the reconciler decided to
 * connect" — the reconciler itself (rearch-05) does not exist until
 * sprint 015. This is not the final design: sprint 015's connector
 * replaces both functions and the watcher goes back to writing
 * `discovered` rows only. See `sprint.md`'s Design Rationale, "watchers
 * stub the connector call directly instead of waiting for the
 * reconciler."
 *
 * ## Injectable seams
 *
 * Every external effect is injectable via {@link UsbWatcherDeps}, so
 * this module is fully unit-testable against `devices.ts`'s own fixture
 * conventions and `link/__fixtures__/FakeByteStream.ts` — no real
 * `serialport`/`node-hid`/SWD I/O, and no real wall-clock waits (a
 * `Scheduler`, the same seam `link/pacing.ts`'s `WritePacer` already
 * uses, stands in for both the boot-window resend schedule and the
 * connect-retry backoff).
 */
import {
  diffDaplinkDevices,
  enumerateDaplinkDevices,
  type DaplinkDevice,
  type DaplinkDeviceLister,
} from "../devices.js";
import { readSwdName as defaultReadSwdName, type CortexMFactory, type SwdNameResult } from "../swdName.js";
import { LineLink, type ByteStream, type LineLinkOptions } from "../link/LineLink.js";
import { serialStream } from "../link/adapters/serialStream.js";
import { realScheduler, type Scheduler } from "../link/pacing.js";
import { Store, type DeviceKind } from "../store/index.js";
import { classifyBanner, deviceIdToName, type ParsedBanner } from "@robot-console/protocol";

const DEFAULT_POLL_INTERVAL_MS = 1000;
/** Bound on `readSwdName` — that function never rejects on its own
 * (see its own doc comment), but nothing bounds how long a stuck
 * HID/SWD attach can take without this. */
const DEFAULT_NAME_TIMEOUT_MS = 2000;
/** `HELLO` resend offsets, in ms from the moment `LineLink.connect()`
 * resolves — covers the macOS boot window (issue rearch-02, review
 * `01-host-device-model.md` §2.1/`02-host-transport.md` §5 item 4). */
const DEFAULT_IDENTIFY_SCHEDULE_MS: readonly number[] = [0, 750, 1500, 2500];
/** Total budget for the whole boot-window identify sequence. */
const DEFAULT_IDENTIFY_BUDGET_MS = 4000;
/** Cap on connect-retry backoff (architecture.md §4 notes: "backoff 1,
 * 2, 4, … ≤ 30 s"). */
const MAX_CONNECT_BACKOFF_MS = 30_000;
/** `board_owner.owner` token this watcher takes while reading a board's
 * SWD name — architecture.md §4's `board_owner` table. */
const NAMING_OWNER = "naming";
/** `tasks.name` this watcher heartbeats every poll. */
const TASK_NAME = "usbWatcher";

function defaultConnectBackoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), MAX_CONNECT_BACKOFF_MS);
}

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
 * Named to match the ticket's own "enumerator/port-factory/SWD-namer/
 * clock" framing. */
export interface UsbWatcherDeps {
  /** The enumerator ("enumerator"). Defaults to
   * {@link enumerateDaplinkDevices}. */
  listDevices?: DaplinkDeviceLister;
  /** The SWD namer. Defaults to `swdName.ts`'s {@link defaultReadSwdName}. */
  readSwdName?: (
    device: DaplinkDevice,
    options?: { createCortexM?: CortexMFactory },
  ) => Promise<SwdNameResult>;
  /** The port factory. Defaults to a real {@link serialStream} over the
   * device's serial-port path. */
  createByteStream?: (device: DaplinkDevice) => ByteStream;
  /** Builds the `LineLink` wrapping a {@link ByteStream}. Defaults to
   * `new LineLink(stream, options)`. Overridable so a test can spy on
   * (or fully substitute) the link the watcher drives. */
  createLineLink?: (stream: ByteStream, options: LineLinkOptions) => LineLink;
  /** The clock — governs both the boot-window resend schedule and the
   * connect-retry backoff. Defaults to {@link realScheduler} (real
   * timers); tests substitute a fake that resolves instantly. */
  scheduler?: Scheduler;
  /** Wall-clock reader for every store timestamp. Defaults to
   * `Date.now`. */
  now?: () => number;
}

export interface UsbWatcherOptions {
  /** Poll interval in ms. Defaults to 1000. */
  pollIntervalMs?: number;
  /** Bound on the SWD name read. Defaults to 2000. */
  nameTimeoutMs?: number;
  /** `HELLO` resend offsets in ms from connect. Defaults to
   * `[0, 750, 1500, 2500]`. The first entry is always the identify sent
   * immediately on connect — later entries are resends. */
  identifySchedule?: readonly number[];
  /** Total ms budget for the whole boot-window identify sequence.
   * Defaults to 4000. */
  identifyBudgetMs?: number;
  /** Connect-retry backoff, keyed by 1-based attempt number. Defaults
   * to `1000 * 2^(attempt-1)`, capped at 30 s. */
  connectBackoffMs?: (attempt: number) => number;
}

export interface UsbWatcherHandle {
  /** Stop polling, abort every in-flight attach task, and close every
   * `LineLink` this watcher still holds open. Idempotent. */
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
  const createByteStream =
    deps.createByteStream ??
    ((device: DaplinkDevice) => {
      const path = device.serialPort?.path;
      if (path === undefined) {
        throw new Error(`usbWatcher: no serial port path for ${device.serialNumber} -- cannot connect`);
      }
      return serialStream(path);
    });
  const createLineLink =
    deps.createLineLink ?? ((stream: ByteStream, options: LineLinkOptions) => new LineLink(stream, options));
  const scheduler = deps.scheduler ?? realScheduler;
  const now = deps.now ?? (() => Date.now());

  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const nameTimeoutMs = opts.nameTimeoutMs ?? DEFAULT_NAME_TIMEOUT_MS;
  const identifySchedule = opts.identifySchedule ?? DEFAULT_IDENTIFY_SCHEDULE_MS;
  const identifyBudgetMs = opts.identifyBudgetMs ?? DEFAULT_IDENTIFY_BUDGET_MS;
  const connectBackoffMs = opts.connectBackoffMs ?? defaultConnectBackoffMs;

  let currentDevices: DaplinkDevice[] = [];
  /** In-flight attach tasks, keyed by USB serial number, so a `removed`
   * event can cancel one before it writes any more rows for a board
   * that is no longer there. */
  const attachTasks = new Map<string, AbortController>();
  /** `LineLink`s this watcher is still holding open (post-identify),
   * keyed by USB serial number, so `removed`/`stop()` can close them. */
  const openLinks = new Map<string, LineLink>();
  let stopped = false;

  function forgetTask(serialNumber: string, controller: AbortController): void {
    if (attachTasks.get(serialNumber) === controller) {
      attachTasks.delete(serialNumber);
    }
  }

  /** Resend the `HELLO` line without re-invoking `LineLink.identify()`
   * itself: a second `identify()` call while the first is still pending
   * would share that same wait rather than send anything new (see
   * `LineLink.identify()`'s own doc comment), so the resend goes
   * through `link.session.connect()` (the only sanctioned way to format
   * `HELLO` — safe to call again here since nothing is in flight on
   * this session yet, per `Session.connect()`'s own doc comment) plus
   * `link.sendLine()`. Whichever `HELLO` a banner reply actually answers,
   * `LineLink`'s already-pending banner wait (armed by the one
   * `identify()` call in {@link identifyWithBootWindowRetry}) catches it.
   */
  function resendHello(link: LineLink): void {
    const line = link.session.connect();
    link.sendLine(line);
  }

  /**
   * Send `HELLO` (via the one sanctioned {@link LineLink.identify} call)
   * and, in parallel, resend it at `identifySchedule`'s later offsets
   * until a banner arrives or `identify()`'s own internal budget
   * (`identifyBudgetMs`, passed as the link's `identifyTimeoutMs`)
   * expires — covering the boot window per this module's own doc
   * comment.
   */
  async function identifyWithBootWindowRetry(link: LineLink): Promise<ParsedBanner | null> {
    let settled = false;
    const identifyPromise = link.identify().then((banner) => {
      settled = true;
      return banner;
    });

    void (async () => {
      let previousOffset = identifySchedule[0] ?? 0;
      for (const offset of identifySchedule.slice(1)) {
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

  /** Open a fresh {@link ByteStream}/`LineLink` and connect, retrying
   * with backoff on a transport-level failure (a fresh pair each
   * attempt — a `LineLink` may only be connected once). Recorded as
   * `links.state = 'failed'` with `fail_count`/`next_retry_at` on every
   * failed attempt, per architecture.md §4's notes. Returns `undefined`
   * if `signal` aborts before a connect succeeds. */
  async function connectWithRetry(device: DaplinkDevice, signal: AbortSignal): Promise<LineLink | undefined> {
    const linkId = usbLinkId(device.serialNumber);
    let attempt = 0;
    for (;;) {
      if (signal.aborted) {
        return undefined;
      }
      attempt++;
      const stream = createByteStream(device);
      const link = createLineLink(stream, { identifyTimeoutMs: identifyBudgetMs });
      try {
        await link.connect({ signal });
        return link;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        store.setLinkState({
          id: linkId,
          state: "failed",
          at: now(),
          reason: message,
          failCount: attempt,
          nextRetryAt: now() + connectBackoffMs(attempt),
        });
        if (signal.aborted) {
          return undefined;
        }
        await scheduler.delay(connectBackoffMs(attempt));
      }
    }
  }

  /** The whole per-attach flow for one newly-`added` device: SWD naming
   * under `board_owner = 'naming'`, then the stubbed connect+identify.
   * See the module doc comment. */
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

    if (signal.aborted || address.path === undefined) {
      // Either the board is already gone, or this attach is HID-only
      // (no serial port yet) -- nothing left to connect to. A later
      // poll reports the serial port's arrival as `updated`, not a
      // fresh `added`, so this watcher never gets a second chance to
      // identify this board through this code path (by design).
      return;
    }

    // TODO(rearch-05): replace with reconciler-scheduled connect. This
    // direct call is a deliberate stand-in until the reconciler exists
    // -- see the module doc comment and sprint.md's Design Rationale.
    const link = await connectWithRetry(device, signal);
    if (!link) {
      return;
    }
    if (signal.aborted) {
      void link.close();
      return;
    }

    const banner = await identifyWithBootWindowRetry(link);
    if (signal.aborted) {
      void link.close();
      return;
    }

    openLinks.set(device.serialNumber, link);

    if (banner) {
      const classification = classifyBanner(banner);
      const kind: DeviceKind = classification.type === "relay" ? "relay" : "robot";
      const name = deviceIdToName(banner.serial);
      store.upsertDevice({
        id: banner.serial,
        name,
        kind,
        role: banner.role,
        usbSerial: device.serialNumber,
        at: now(),
      });
      store.upsertLink({ id: linkId, transport: "usb", address, deviceId: banner.serial, at: now() });
      store.setLinkState({ id: linkId, state: "connected", at: now() });
      if (classification.type === "robot") {
        store.setOwned(banner.serial, true, now());
      }
    } else {
      store.setLinkState({ id: linkId, state: "unresponsive", at: now(), reason: "no-banner-within-budget" });
    }
  }

  function handleAdded(device: DaplinkDevice): void {
    const controller = new AbortController();
    attachTasks.set(device.serialNumber, controller);
    void attach(device, controller.signal)
      .catch(() => {
        // A failed attach must not take down the poll loop over one
        // board -- failure is already recorded as store state
        // (links.state = 'failed'/'unresponsive') wherever this module
        // can attribute it; anything else (a thrown SWD/enumerator
        // surprise) is swallowed here rather than crashing the watcher.
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

    const link = openLinks.get(device.serialNumber);
    openLinks.delete(device.serialNumber);
    if (link) {
      void link.close();
    }

    store.setLinkState({ id: usbLinkId(device.serialNumber), state: "stale", at: now() });
    store.releaseBoardOwner(device.serialNumber, NAMING_OWNER);
  }

  async function pollOnce(): Promise<void> {
    const next = await listDevices();
    // Opt into the `updated` bucket (ticket 014-010): this watcher is
    // the consumer `diffDaplinkDevices`'s `updated` behaviour was built
    // for (ticket 014-007) -- refresh address, keep everything else
    // unchanged, never re-run SWD naming/identify. The legacy
    // remove+add default stays in place for `DeviceWatcher`
    // (`deviceRegistry.ts`'s older attach/detach path relies on seeing
    // `removed` to abandon stale in-flight work).
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
      for (const link of openLinks.values()) {
        void link.close();
      }
      openLinks.clear();
    },
  };
}
