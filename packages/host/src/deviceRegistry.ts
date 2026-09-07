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
import type { DeviceListEntry, LineDirection } from "./wsMessages.js";

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
  private readonly mutex = new KeyedMutex();
  private readonly states = new Map<string, DeviceState>();
  private unsubscribeWatcher: (() => void) | undefined;

  private readonly devicesListeners = new Set<DevicesListener>();
  private readonly lineListeners = new Set<LineListener>();
  private readonly errorListeners = new Set<RegistryErrorListener>();

  constructor(options: DeviceRegistryOptions = {}) {
    this.watcher = options.watcher ?? new DeviceWatcher();
    this.resolveName = options.resolveName ?? readSwdName;
    this.createLink = options.createLink ?? defaultLinkFactory;
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
}
