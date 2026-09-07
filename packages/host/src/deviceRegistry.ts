/**
 * deviceRegistry.ts — composes `devices.ts` (live enumeration),
 * `swdName.ts` (five-letter naming), and `UsbSerialLink` (per-device
 * I/O) into one live-updated set of {@link DeviceListEntry} snapshots
 * and per-device line/error events, for `server.ts` to push over the
 * WebSocket. This module owns *orchestration* only -- which device
 * operation runs when, and that two operations never race on the same
 * physical board -- never naming, banner-parsing, framing, or
 * sequencing logic, all of which stays in the composed modules.
 *
 * ## The race this module exists to prevent
 *
 * `swdName.ts#readSwdName` attaches to a board over SWD; `UsbSerialLink
 * #open()` resets the same board on macOS (opening the port toggles
 * DTR). Reading a name while a link is opening, or opening two links to
 * one board, must never happen concurrently -- either can corrupt or
 * disrupt the other's in-flight operation. {@link KeyedMutex} below
 * serializes every operation this module performs against a given
 * device's USB serial number (name resolution, link open, link close,
 * a line send) so at most one is ever in flight per device at a time,
 * while different devices proceed fully in parallel.
 *
 * ## Attach flow
 *
 * On each `DeviceWatcher` diff, a newly-added device is registered
 * immediately (so it is visible, named `null`, right away -- the
 * device list must never block on SWD/serial I/O) and its name/role
 * resolution is kicked off asynchronously, serialized per-device as
 * above: resolve the five-letter name over SWD first (fast, no reset),
 * then attempt to open a `UsbSerialLink` to learn its role from the
 * boot banner. A device that never replies to `HELLO` (a silently
 * running board -- see the ticket) still ends up listed, named, with
 * `role: null` and a `linkError` -- `UsbSerialLink.open()`'s own
 * timeout bounds this, so this never hangs the device list.
 *
 * ## Detach flow
 *
 * A removed device's link (if open) is closed best-effort and its
 * state discarded. A link-level error arriving after open (e.g. the
 * board is unplugged) is caught and turned into a state update plus an
 * {@link ErrorMessage}-shaped event -- never an uncaught exception that
 * would take the whole server down over one board.
 *
 * ## Flash flow (sprint 2)
 *
 * {@link DeviceRegistry.requestFlash} is one more operation run through
 * the same per-device {@link KeyedMutex} as name resolution/link open/
 * close/send -- not a new synchronization mechanism. It composes
 * `config.ts` (which firmware source) -> `releases.ts` (fetch+verify
 * the hex) -> `flash.ts` (write it) as one mutex-guarded task: tear
 * down any open link first (so `flash.ts`'s DAPjs session never
 * contends with an open serial port over the same physical board),
 * look up the configured `FirmwareSource`, fetch+verify the hex
 * (reporting `"fetching"`/`"verifying"` progress), write it (reporting
 * `"erasing"`/`"writing"`/`"resetting"` progress), and -- on success --
 * re-open a link exactly the way the attach flow above already does, so
 * the newly-flashed firmware's banner is picked up with no separate
 * manual Connect click. See {@link DeviceRegistry.requestFlash}'s own
 * doc comment for why this task holds the device's mutex slot across
 * the network fetch rather than releasing and re-acquiring it. A
 * failure at any stage clears `flashStatus` and reports a `flash-result`
 * error -- it never leaves `flashStatus` stuck or the registry believing
 * a link is open when {@link teardownLink} already closed it.
 */

import type { DecodedLine, ParsedBanner } from "@robot-console/protocol";
import { encodeLine } from "@robot-console/protocol";
import {
  DeviceWatcher,
  type DaplinkDevice,
  type DeviceChangeEvent,
} from "./devices.js";
import { readSwdName, type SwdNameResult } from "./swdName.js";
import { UsbSerialLink } from "./link/UsbSerialLink.js";
import { getFirmwareConfig, type FirmwareConfigMap } from "./config.js";
import { resolveRelease, fetchAndVerifyHex } from "./releases.js";
import { flash } from "./flash.js";
import type { DeviceListEntry, LineDirection, FirmwareKind, FlashPhase } from "./wsMessages.js";

// ---------------------------------------------------------------------
// Injectable seams (real implementations by default; fakes in tests)
// ---------------------------------------------------------------------

/** The slice of `UsbSerialLink` this module actually uses. Kept narrow
 * and exported so tests can drive {@link DeviceRegistry} against a
 * fully synthetic fake link, without any real `serialport` I/O -- the
 * ticket's own testing note asks for exactly this. The real
 * `UsbSerialLink` class satisfies this structurally. */
export interface UsbSerialLinkLike {
  open(): Promise<ParsedBanner>;
  close(): Promise<void>;
  sendLine(line: string): void;
  onLine(listener: (line: DecodedLine) => void): () => void;
  onError(listener: (err: Error) => void): () => void;
}

export type NameResolver = (device: DaplinkDevice) => Promise<SwdNameResult>;
export type LinkFactory = (portPath: string) => UsbSerialLinkLike;

function defaultLinkFactory(portPath: string): UsbSerialLinkLike {
  return new UsbSerialLink(portPath);
}

// ---------------------------------------------------------------------
// KeyedMutex -- serialize operations per device, not globally
// ---------------------------------------------------------------------

/**
 * Runs async tasks registered under the same `key` strictly one at a
 * time, in the order {@link run} was called, while tasks under
 * different keys run fully concurrently. A task that throws/rejects
 * does not wedge later tasks queued under the same key -- the chain
 * always advances regardless of the previous task's outcome; only the
 * caller of that specific {@link run} call observes its rejection.
 */
class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    // Store a variant that always resolves as the new chain tail, so a
    // rejection from this task never poisons the next queued task under
    // the same key -- only `result` (returned to this call's caller)
    // carries the rejection onward.
    this.tails.set(
      key,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }
}

// ---------------------------------------------------------------------
// Per-device state
// ---------------------------------------------------------------------

interface DeviceState {
  device: DaplinkDevice;
  name: string | null;
  nameError?: { reason: string; message: string } | undefined;
  role: string | null;
  link?: UsbSerialLinkLike | undefined;
  linkOpen: boolean;
  linkError?: string | undefined;
  unsubscribeLine?: (() => void) | undefined;
  unsubscribeError?: (() => void) | undefined;
  /** Present only while a flash is in flight for this device (sprint
   * 2) -- set at the start of {@link DeviceRegistry.requestFlash}'s
   * task and cleared (success or error) at its end. Reflected into
   * {@link DeviceListEntry.flashStatus} by {@link toEntry}. */
  flashStatus?: { firmware: FirmwareKind; phase: FlashPhase } | undefined;
}

function toEntry(state: DeviceState): DeviceListEntry {
  const entry: DeviceListEntry = {
    id: state.device.serialNumber,
    serialNumber: state.device.serialNumber,
    displaySerial: state.device.displaySerial,
    name: state.name,
    role: state.role,
    port: state.device.serialPort?.path ?? null,
    linkOpen: state.linkOpen,
  };
  if (state.nameError) {
    entry.nameError = state.nameError;
  }
  if (state.linkError) {
    entry.linkError = state.linkError;
  }
  if (state.flashStatus) {
    entry.flashStatus = state.flashStatus;
  }
  return entry;
}

/** Reconstruct a received line's raw wire text from its decoded form,
 * via `v6/codec.ts`'s own `encodeLine` -- composing the protocol
 * package's framing rather than reimplementing it here (see this
 * module's own boundary doc comment). Falls back to a plain space-join
 * only if re-encoding itself throws, which should not happen for a
 * `decodeLine`-produced value; a received line must never be dropped
 * silently just because display formatting failed. */
function reconstructLineText(decoded: DecodedLine): string {
  try {
    return encodeLine(decoded.verb, decoded.fields, decoded.id).replace(/\n$/, "");
  } catch {
    const parts = [decoded.verb, ...decoded.fields];
    if (decoded.id !== undefined) {
      parts.push(`#${decoded.id}`);
    }
    return parts.join(" ");
  }
}

// ---------------------------------------------------------------------
// DeviceRegistry
// ---------------------------------------------------------------------

export type DevicesListener = (devices: DeviceListEntry[]) => void;
export type LineListener = (deviceId: string, direction: LineDirection, line: string) => void;
export type RegistryErrorListener = (deviceId: string | undefined, message: string) => void;
/** Notified once per {@link FlashPhase} as a `requestFlash` task
 * advances -- mirrors {@link LineListener}'s per-event shape rather
 * than a bulk snapshot, since `server.ts` (ticket 006) forwards these
 * directly as {@link FlashProgressMessage}-shaped broadcasts. */
export type FlashProgressListener = (deviceId: string, firmware: FirmwareKind, phase: FlashPhase) => void;
/** Notified exactly once per `requestFlash` call, with its terminal
 * outcome -- `message` is present only on `status: "error"`, mirroring
 * {@link FlashResultMessage}'s own shape. */
export type FlashResultListener = (
  deviceId: string,
  firmware: FirmwareKind,
  status: "ok" | "error",
  message?: string,
) => void;

export interface DeviceRegistryOptions {
  /** Injectable device watcher; defaults to a real {@link DeviceWatcher}
   * (real USB/HID enumeration). Tests substitute one backed by a
   * fixture `listDevices` function. */
  watcher?: DeviceWatcher;
  /** Injectable SWD name resolver; defaults to {@link readSwdName}. */
  resolveName?: NameResolver;
  /** Injectable `UsbSerialLink` factory; defaults to real
   * `UsbSerialLink`. Tests substitute a fake {@link UsbSerialLinkLike}. */
  createLink?: LinkFactory;
  /** Injectable firmware-source config accessor; defaults to a call to
   * `config.ts`'s real {@link getFirmwareConfig} (real environment/
   * dotconfig `.env` parsing). Tests substitute a function returning a
   * fixture {@link FirmwareConfigMap}, following this file's existing
   * `resolveName`/`createLink` injection pattern exactly -- no real
   * environment setup needed to exercise `requestFlash`. */
  getFirmwareConfig?: () => FirmwareConfigMap;
  /** Injectable `releases.ts` release resolver; defaults to the real,
   * network-backed {@link resolveRelease}. Tests substitute a fully
   * synthetic fake, never a real GitHub call. */
  resolveRelease?: typeof resolveRelease;
  /** Injectable `releases.ts` hex fetch+verify; defaults to the real,
   * network-backed {@link fetchAndVerifyHex}. Tests substitute a fully
   * synthetic fake, never a real GitHub call. */
  fetchAndVerifyHex?: typeof fetchAndVerifyHex;
  /** Injectable `flash.ts` entry point; defaults to the real DAPjs/
   * node-hid-backed {@link flash}. Tests substitute a fully synthetic
   * fake, never real USB/SWD I/O. */
  flash?: typeof flash;
}

/**
 * Live registry of attached devices, their resolved identity, and any
 * open per-device link -- the one stateful object `server.ts` composes
 * to turn `devices.ts`/`swdName.ts`/`UsbSerialLink` into WebSocket
 * messages. See the module doc comment for the attach/detach flows and
 * the race this module's {@link KeyedMutex} usage prevents.
 */
export class DeviceRegistry {
  private readonly watcher: DeviceWatcher;
  private readonly resolveName: NameResolver;
  private readonly createLink: LinkFactory;
  private readonly getFirmwareConfigFn: () => FirmwareConfigMap;
  private readonly resolveReleaseFn: typeof resolveRelease;
  private readonly fetchAndVerifyHexFn: typeof fetchAndVerifyHex;
  private readonly flashFn: typeof flash;
  private readonly mutex = new KeyedMutex();
  private readonly states = new Map<string, DeviceState>();
  private unsubscribeWatcher: (() => void) | undefined;

  private readonly devicesListeners = new Set<DevicesListener>();
  private readonly lineListeners = new Set<LineListener>();
  private readonly errorListeners = new Set<RegistryErrorListener>();
  private readonly flashProgressListeners = new Set<FlashProgressListener>();
  private readonly flashResultListeners = new Set<FlashResultListener>();

  constructor(options: DeviceRegistryOptions = {}) {
    this.watcher = options.watcher ?? new DeviceWatcher();
    this.resolveName = options.resolveName ?? readSwdName;
    this.createLink = options.createLink ?? defaultLinkFactory;
    this.getFirmwareConfigFn = options.getFirmwareConfig ?? (() => getFirmwareConfig());
    this.resolveReleaseFn = options.resolveRelease ?? resolveRelease;
    this.fetchAndVerifyHexFn = options.fetchAndVerifyHex ?? fetchAndVerifyHex;
    this.flashFn = options.flash ?? flash;
  }

  /** Start watching for devices. Idempotent-ish in practice (callers
   * are expected to call this once); an immediate `pollOnce()` is
   * kicked off so the first snapshot arrives promptly rather than
   * waiting a full poll interval. */
  start(): void {
    this.unsubscribeWatcher = this.watcher.onChange((event) => {
      this.handleChange(event);
    });
    this.watcher.start();
    void this.watcher.pollOnce();
  }

  /** Stop watching and close every open link, best-effort. */
  async stop(): Promise<void> {
    this.watcher.stop();
    this.unsubscribeWatcher?.();
    this.unsubscribeWatcher = undefined;
    const closes = [...this.states.values()].map((state) =>
      this.teardownLink(state).catch(() => {
        // Best-effort shutdown -- a failure to close one link must not
        // stop the others from being torn down too.
      }),
    );
    await Promise.all(closes);
    this.states.clear();
  }

  /** The current device list, sorted by id for a deterministic order. */
  snapshot(): DeviceListEntry[] {
    return [...this.states.values()]
      .map(toEntry)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  onDevicesChanged(listener: DevicesListener): () => void {
    this.devicesListeners.add(listener);
    return () => {
      this.devicesListeners.delete(listener);
    };
  }

  onLine(listener: LineListener): () => void {
    this.lineListeners.add(listener);
    return () => {
      this.lineListeners.delete(listener);
    };
  }

  onError(listener: RegistryErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  /** Subscribe to per-phase progress events from an in-flight
   * `requestFlash` task (sprint 2). Returns an unsubscribe function. */
  onFlashProgress(listener: FlashProgressListener): () => void {
    this.flashProgressListeners.add(listener);
    return () => {
      this.flashProgressListeners.delete(listener);
    };
  }

  /** Subscribe to the terminal outcome of `requestFlash` tasks (sprint
   * 2). Returns an unsubscribe function. */
  onFlashResult(listener: FlashResultListener): () => void {
    this.flashResultListeners.add(listener);
    return () => {
      this.flashResultListeners.delete(listener);
    };
  }

  /** (Re-)open a link to a device, e.g. retrying after a silent-board
   * timeout. No-op if already open. Errors are reported via
   * {@link onError} and reflected in the next {@link onDevicesChanged}
   * snapshot -- never thrown to the caller. */
  async requestOpen(deviceId: string): Promise<void> {
    await this.mutex.run(deviceId, async () => {
      const state = this.states.get(deviceId);
      if (!state) {
        this.emitError(deviceId, `no such device: ${deviceId}`);
        return;
      }
      if (state.linkOpen) {
        return;
      }
      await this.openLink(state);
    });
  }

  /** Close an open link to a device. No-op if not open. */
  async requestClose(deviceId: string): Promise<void> {
    await this.mutex.run(deviceId, async () => {
      const state = this.states.get(deviceId);
      if (!state) {
        this.emitError(deviceId, `no such device: ${deviceId}`);
        return;
      }
      await this.teardownLink(state);
      this.emitDevices();
    });
  }

  /** Send a line to a device's open link. Reports (via {@link onError})
   * rather than throws if the device is unknown, has no open link, or
   * the underlying write itself fails. On success, also emits the sent
   * line back out via {@link onLine} (`direction: "tx"`) so every
   * connected client's console view reflects it, not just the sender. */
  async sendLine(deviceId: string, line: string): Promise<void> {
    await this.mutex.run(deviceId, async () => {
      const state = this.states.get(deviceId);
      if (!state?.linkOpen || !state.link) {
        this.emitError(deviceId, `device ${deviceId} has no open link`);
        return;
      }
      try {
        state.link.sendLine(line);
        this.emitLine(deviceId, "tx", line);
      } catch (error) {
        this.emitError(deviceId, error instanceof Error ? error.message : String(error));
      }
    });
  }

  /**
   * Flash `firmware` onto a device: orchestrates `config.ts` (which
   * source) -> `releases.ts` (fetch+verify the hex) -> `flash.ts`
   * (write it), run as one more task through the same per-device
   * {@link KeyedMutex} as {@link requestOpen}/{@link requestClose}/
   * {@link sendLine} -- no new synchronization primitive (see the
   * module doc comment's "Flash flow" section). An unknown `deviceId`
   * is reported via {@link onError}, matching {@link requestOpen}'s own
   * handling -- never thrown to the caller.
   *
   * ## Mutex scope: the whole task, including `releases.ts`'s network fetch
   *
   * This is a deliberate choice, not an oversight. The alternative --
   * release the mutex for the (slow, network-bound) fetch+verify step
   * and re-acquire it only for teardown/write/reopen -- would open a
   * window in which a `requestOpen`/`requestClose`/`sendLine` (or a
   * second `requestFlash`) could run against *this same device* in
   * between. When this task resumed and called {@link teardownLink}, it
   * would then be racing whatever that interleaved operation left the
   * link in -- reintroducing, for a destructive flash, exactly the OS
   * port-lock race described in
   * `port-lock-contention-between-identify-and-user-open.md`, except
   * now the loser of the race is a firmware write instead of a benign
   * identify retry. Holding the mutex for the fetch's duration instead
   * costs one thing: `requestOpen`/`requestClose`/`sendLine`/name
   * resolution on *this one device* (never other devices -- the mutex
   * is per-device) queue behind the fetch until it completes. In
   * practice this costs little: the flash buttons only ever render for
   * a device that has already failed to identify (`role: null`,
   * `linkError` set -- see `sprint.md`'s SUC-001 precondition), so
   * there is normally no open link or console traffic on this device
   * for the fetch to actually block.
   *
   * ## Failure recovery
   *
   * A failure at any stage -- an unconfigured firmware source, a
   * `releases.ts` failure, a `flash.ts` failure, or an unexpected throw
   * from any injected step -- clears `flashStatus` and reports a
   * `flash-result` `status: "error"` event before returning. `flashStatus`
   * is never left set past the end of this task, and the registry never
   * believes a link is open once {@link teardownLink} has already closed
   * it: a failure after teardown simply leaves `linkOpen: false` (as
   * teardown itself sets), the same state {@link requestClose} leaves
   * behind, ready for a future {@link requestOpen} retry.
   */
  async requestFlash(deviceId: string, firmware: FirmwareKind): Promise<void> {
    await this.mutex.run(deviceId, async () => {
      const state = this.states.get(deviceId);
      if (!state) {
        this.emitError(deviceId, `no such device: ${deviceId}`);
        return;
      }
      await this.runFlash(state, firmware);
    });
  }

  /** The mutex-guarded body of {@link requestFlash} -- see that method's
   * doc comment for the mutex-scope and failure-recovery rationale. */
  private async runFlash(state: DeviceState, firmware: FirmwareKind): Promise<void> {
    const deviceId = state.device.serialNumber;
    // Set at the very start (before teardown even) so a client that
    // observes the very next snapshot already sees flashStatus, per the
    // ticket's "set at the start of the flash task" requirement. There
    // is no dedicated FlashPhase for "tearing down the old link", so
    // this first phase is reported as "fetching" -- the next real
    // progress event ("verifying", once releases.ts resolves) replaces
    // it, same best-effort phase-reporting precedent flash.ts's own doc
    // comment already accepts for DAPjs's coarser event surface.
    this.setFlashPhase(state, deviceId, firmware, "fetching");

    try {
      // Tear down any open link before touching config/network/SWD --
      // flash.ts's DAPjs session must never contend with an open serial
      // port over the same physical board (see this class's own
      // requestFlash doc comment, and sprint.md's Design Rationale). In
      // the common case (a failed-identify device) there is nothing
      // open here; this call is defensive for any other caller.
      await this.teardownLink(state);
      this.emitDevices();

      const source = this.getFirmwareConfigFn()[firmware];
      if (!source) {
        this.failFlash(state, deviceId, firmware, `no firmware source configured for "${firmware}"`);
        return;
      }

      const resolved = await this.resolveReleaseFn(source);
      if ("reason" in resolved) {
        this.failFlash(state, deviceId, firmware, resolved.message);
        return;
      }

      // fetchAndVerifyHex both downloads and sha256-verifies in one
      // call (releases.ts has no seam between the two) -- "verifying"
      // is reported for the whole call, same best-effort phase mapping
      // as flash.ts's own erase/write/reset reporting.
      this.setFlashPhase(state, deviceId, firmware, "verifying");
      const fetched = await this.fetchAndVerifyHexFn(resolved);
      if ("error" in fetched) {
        this.failFlash(state, deviceId, firmware, fetched.error);
        return;
      }

      const onProgress = (phase: FlashPhase) => {
        this.setFlashPhase(state, deviceId, firmware, phase);
      };
      const outcome = await this.flashFn(state.device, fetched.hex.toString("utf-8"), onProgress);
      if (outcome.status === "error") {
        this.failFlash(state, deviceId, firmware, outcome.error);
        return;
      }

      state.flashStatus = undefined;
      this.emitFlashResult(deviceId, firmware, "ok");
      this.emitDevices();

      // Pick up the newly-flashed firmware's banner without a separate
      // manual Connect click (SUC-001's postcondition). openLink never
      // throws and reports its own errors via linkError/onDevicesChanged
      // rather than rejecting, so a failed re-open here never turns an
      // already-succeeded flash into a reported failure.
      await this.openLink(state);
    } catch (error) {
      // Defense in depth: every injected step here (config.ts,
      // releases.ts, flash.ts) documents "never throws", but a flash
      // must not leave flashStatus stuck even if that contract is ever
      // violated -- by a future change, or by a test's own fake.
      this.failFlash(state, deviceId, firmware, error instanceof Error ? error.message : String(error));
    }
  }

  /** Advance an in-flight flash to `phase`: update `flashStatus`, emit a
   * {@link onFlashProgress} event, and emit an updated device snapshot
   * so a client that reconnects mid-flash sees the current phase. */
  private setFlashPhase(state: DeviceState, deviceId: string, firmware: FirmwareKind, phase: FlashPhase): void {
    state.flashStatus = { firmware, phase };
    this.emitFlashProgress(deviceId, firmware, phase);
    this.emitDevices();
  }

  /** End an in-flight flash in failure: clear `flashStatus` and emit a
   * `flash-result` `status: "error"` event plus an updated snapshot. */
  private failFlash(state: DeviceState, deviceId: string, firmware: FirmwareKind, message: string): void {
    state.flashStatus = undefined;
    this.emitFlashResult(deviceId, firmware, "error", message);
    this.emitDevices();
  }

  // ---- watcher-driven attach/detach ------------------------------------

  private handleChange(event: DeviceChangeEvent): void {
    // Capture the *current* state object for each removed device before
    // any added device in the same diff (a modified device shows up as
    // a remove+add pair) has a chance to overwrite the map entry -- see
    // the module doc comment.
    for (const device of event.removed) {
      const state = this.states.get(device.serialNumber);
      void this.mutex.run(device.serialNumber, async () => {
        if (state) {
          await this.teardownLink(state).catch(() => {});
        }
        if (this.states.get(device.serialNumber) === state) {
          this.states.delete(device.serialNumber);
        }
        this.emitDevices();
      });
    }

    for (const device of event.added) {
      const state: DeviceState = {
        device,
        name: null,
        role: null,
        linkOpen: false,
      };
      this.states.set(device.serialNumber, state);
      void this.mutex.run(device.serialNumber, async () => {
        await this.resolveNameAndOpen(state);
      });
    }

    // Emit once after scheduling the whole diff, in addition to each
    // mutexed step's own emit below -- clients see "attached, name
    // pending" immediately instead of waiting for SWD/serial I/O.
    this.emitDevices();
  }

  private async resolveNameAndOpen(state: DeviceState): Promise<void> {
    const result = await this.resolveName(state.device);
    // The device may have been removed (and even re-added under a new
    // state object) while the SWD read was in flight; only apply the
    // result if this state object is still the live one.
    if (this.states.get(state.device.serialNumber) !== state) {
      return;
    }
    if (result.status === "named") {
      state.name = result.name;
      state.nameError = undefined;
    } else {
      state.name = null;
      state.nameError = { reason: result.reason, message: result.error };
    }
    this.emitDevices();

    await this.openLink(state);
  }

  private async openLink(state: DeviceState): Promise<void> {
    const portPath = state.device.serialPort?.path;
    if (!portPath) {
      state.linkError = "no serial port available for this device";
      this.emitDevices();
      return;
    }

    const link = this.createLink(portPath);
    try {
      const banner = await link.open();
      if (this.states.get(state.device.serialNumber) !== state) {
        // Removed while opening -- don't leak the link we just opened.
        await link.close().catch(() => {});
        return;
      }
      state.link = link;
      state.linkOpen = true;
      state.linkError = undefined;
      state.role = banner.role;
      state.unsubscribeLine = link.onLine((decoded) => {
        this.emitLine(state.device.serialNumber, "rx", reconstructLineText(decoded));
      });
      state.unsubscribeError = link.onError((err) => {
        this.handleLinkError(state, err);
      });
    } catch (error) {
      // A silent board (never replies to HELLO) times out here rather
      // than hanging -- UsbSerialLink.open()'s own timeout bounds this.
      // Degrade gracefully: the device stays listed, named, with role
      // still null and this reason recorded.
      state.linkOpen = false;
      state.link = undefined;
      state.linkError = error instanceof Error ? error.message : String(error);
      // Close the link we just created before giving up on it. By the
      // time `link.open()`'s HELLO-banner-reply wait times out, its
      // underlying `SerialPort` is already open at the OS level (see
      // `UsbSerialLink.open()`'s own doc comment: the port-open wait
      // resolves before the banner wait even starts) -- verified
      // against real hardware (sprint 003 ticket 005): leaving this
      // link unclosed here held that OS-level handle for the rest of
      // the process's lifetime, permanently locking the port
      // ("Cannot lock port") against every later open attempt on this
      // device, including a manual retry and `requestFlash`'s own
      // post-flash reopen. Best-effort -- a failed close must not mask
      // the `linkError` already recorded above, same precedent as
      // `teardownLink`'s and `flash.ts`'s own cleanup.
      await link.close().catch(() => {});
    }
    this.emitDevices();
  }

  private handleLinkError(state: DeviceState, err: Error): void {
    state.linkOpen = false;
    state.linkError = err.message;
    this.emitDevices();
    this.emitError(state.device.serialNumber, err.message);
  }

  private async teardownLink(state: DeviceState): Promise<void> {
    state.unsubscribeLine?.();
    state.unsubscribeError?.();
    state.unsubscribeLine = undefined;
    state.unsubscribeError = undefined;
    const link = state.link;
    state.link = undefined;
    state.linkOpen = false;
    if (link) {
      await link.close();
    }
  }

  // ---- event dispatch ---------------------------------------------------

  private emitDevices(): void {
    const devices = this.snapshot();
    for (const listener of this.devicesListeners) {
      listener(devices);
    }
  }

  private emitLine(deviceId: string, direction: LineDirection, line: string): void {
    for (const listener of this.lineListeners) {
      listener(deviceId, direction, line);
    }
  }

  private emitError(deviceId: string | undefined, message: string): void {
    for (const listener of this.errorListeners) {
      listener(deviceId, message);
    }
  }

  private emitFlashProgress(deviceId: string, firmware: FirmwareKind, phase: FlashPhase): void {
    for (const listener of this.flashProgressListeners) {
      listener(deviceId, firmware, phase);
    }
  }

  private emitFlashResult(
    deviceId: string,
    firmware: FirmwareKind,
    status: "ok" | "error",
    message?: string,
  ): void {
    for (const listener of this.flashResultListeners) {
      listener(deviceId, firmware, status, message);
    }
  }
}
