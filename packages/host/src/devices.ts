/**
 * devices.ts — enumerate attached DAPLink micro:bits and join their two
 * USB personas (serial port + CMSIS-DAP HID) into one record.
 *
 * Per `docs/design/specification.md` §4.1: a micro:bit's DAPLink
 * interface chip enumerates as one composite USB device (`VID 0x0D28 /
 * PID 0x0204`) presenting several interfaces — among them a CDC serial
 * port (what `UsbSerialLink`, ticket 008, talks to) and a CMSIS-DAP HID
 * interface (what `swdName.ts`, ticket 007, and `flash.ts` talk to over
 * SWD). Every interface on the same board reports the **same USB serial
 * number** — the interface chip's UID — and that serial number is the
 * join key used across the rest of the fleet tooling (pyOCD, mbdeploy,
 * mbrelay all key on it). This module's only job is: filter both
 * enumerations to DAPLink's VID/PID, then join them on that shared
 * serial number.
 *
 * Boundary (deliberately narrow — see the ticket):
 *   - This module does NOT compute the five-letter friendly name. That
 *     name is a hash of the *target nRF's* `FICR.DEVICEID[1]`, read over
 *     SWD by `swdName.ts` (ticket 007) — a different chip than the
 *     interface chip whose serial this module reads. See
 *     {@link FiveLetterName}.
 *   - This module does NOT open the serial port or speak the `HELLO`
 *     protocol. That is `UsbSerialLink` (ticket 008).
 *
 * ## The shared-prefix/suffix trap
 *
 * A DAPLink USB serial is a hex string structured as:
 *
 *   board(4) family(4) hic(8) unique(16) pad(8) hic(8)
 *
 * The leading 16 hex characters (board + family + hic) and the trailing
 * 16 hex characters (pad + hic) are properties of the *interface chip
 * and firmware build*, not the individual board — every micro:bit on a
 * bench sharing the same DAPLink build and interface chip model reports
 * **identical** values in both of those spans. Only the middle 16-char
 * "unique" field actually varies board-to-board. Concretely: four
 * micro:bits on one bench can all report a serial ending in the exact
 * same `...000000006e052820`. A short/display form of the serial must
 * therefore be sliced from the middle ({@link shortSerialDisplay}),
 * never from a prefix or suffix — a tail slice names every board on the
 * bench identically.
 */

import { devices as listHidDevicesRaw, type Device as HidDeviceListing } from "node-hid";
import { SerialPort } from "serialport";

/** Element type of `SerialPort.list()`. `serialport` does not re-export
 * `PortInfo` by name from its package root, so it is derived
 * structurally here instead of reaching into the
 * `@serialport/bindings-interface` transitive dependency directly. */
export type SerialPortListing = Awaited<ReturnType<typeof SerialPort.list>>[number];

/** DAPLink's USB vendor id (mbed interface firmware). */
export const DAPLINK_VENDOR_ID = 0x0d28;
/** DAPLink's USB product id (CMSIS-DAP composite device). */
export const DAPLINK_PRODUCT_ID = 0x0204;

/**
 * Five-letter friendly name (`swdName.ts`, ticket 007). This module
 * only ever sees the *interface chip's* identity (the USB serial
 * above) — never the target nRF's `FICR.DEVICEID[1]` — so it has no way
 * to compute a name and {@link DaplinkDevice} never carries one. This
 * alias exists so ticket 007's merge step has a stable, documented name
 * for the value it produces rather than each caller inventing an ad hoc
 * field name at the call site.
 */
export type FiveLetterName = string;

/** The serial-port half of a joined device, trimmed to what callers
 * actually need (not the full `serialport` listing). */
export interface SerialPortInfo {
  /** OS device path (e.g. `/dev/cu.usbmodemXXXX`, `COM3`). Renumbers
   * across replugs — never use this to re-identify a device, only to
   * open it once already identified by serial number. */
  path: string;
  manufacturer?: string;
}

/** The CMSIS-DAP HID half of a joined device, trimmed to what callers
 * actually need (not the full `node-hid` listing). */
export interface HidInterfaceInfo {
  /** OS HID device path. This is the handle ticket 007 needs to attach
   * over SWD. Absent on platforms/permissions setups where `node-hid`
   * cannot resolve a path for the interface. */
  path?: string;
  product?: string;
}

/**
 * Whether a joined device was found on both USB personas, or only one.
 * Exists so a partial join is surfaced explicitly rather than silently
 * dropped (no HID match) or silently treated as fully usable (no serial
 * port match, e.g. mid-enumeration on some platforms).
 */
export type DeviceAvailability = "full" | "serial-only" | "hid-only";

/**
 * One physical DAPLink micro:bit, joined across its serial-port and
 * CMSIS-DAP HID USB personas by shared USB serial number. Deliberately
 * narrow: serial number + serial port info + HID handle, nothing more
 * (see the module doc for what is explicitly out of scope).
 */
export interface DaplinkDevice {
  /** USB serial number of the DAPLink interface chip — the join key.
   * Shared identically across every USB interface of the same board,
   * and (per the module doc's trap) shares a prefix/suffix with other
   * boards using the same interface-chip model. */
  serialNumber: string;
  /** Short display form of {@link serialNumber}, sliced from the
   * board-unique middle field. Safe to show to distinguish boards that
   * share a prefix/suffix; see {@link shortSerialDisplay}. */
  displaySerial: string;
  availability: DeviceAvailability;
  /** Present when a matching entry was found in `serialport`'s list. */
  serialPort?: SerialPortInfo;
  /** Present when a matching entry was found in `node-hid`'s list. */
  hid?: HidInterfaceInfo;
}

/**
 * DAPLink USB serials are `board(4) family(4) hic(8) unique(16)
 * pad(8) hic(8)` hex characters — 48 total. The board-unique "unique"
 * field sits at characters [16, 32). See the module doc's trap section
 * for why this must be a middle slice, not a tail slice.
 */
const SERIAL_UNIQUE_FIELD_START = 16;
const SERIAL_UNIQUE_FIELD_END = 32;

/**
 * Short display form of a DAPLink USB serial number, taken from the
 * board-unique middle field rather than the (commonly shared) prefix or
 * suffix. Falls back to the full string for serials shorter than the
 * expected 48-char DAPLink shape (e.g. synthetic test fixtures, or an
 * interface-chip family this code hasn't been taught about) rather than
 * guessing at an offset that may not apply.
 */
export function shortSerialDisplay(serialNumber: string): string {
  if (serialNumber.length >= SERIAL_UNIQUE_FIELD_END) {
    return serialNumber.slice(SERIAL_UNIQUE_FIELD_START, SERIAL_UNIQUE_FIELD_END);
  }
  return serialNumber;
}

// ---------------------------------------------------------------------
// Darwin tty./cu. path translation (moved here from `link/UsbSerialLink.ts`
// per sprint 003 ticket 001 — this is the one canonical place the
// translation happens now; every consumer of `SerialPortInfo.path`
// agrees, not just the one call site that opens the port)
// ---------------------------------------------------------------------

const DARWIN_TTY_PREFIX = "/dev/tty.";
const DARWIN_CU_PREFIX = "/dev/cu.";

/**
 * Translate a `serialport.list()`-reported path to its callout
 * (`/dev/cu.*`) form.
 *
 * macOS reports DAPLink ports under their `/dev/tty.*` name. Opening a
 * `tty.*` device on macOS **blocks waiting for DCD (carrier detect)**
 * and can hang indefinitely — verified against real hardware in sprint
 * 1. `/dev/cu.*` is the callout counterpart of the exact same device
 * and opens immediately, without waiting for DCD. Every other platform
 * (Linux, where `serialport.list()` already reports the port under one
 * name) is returned unchanged.
 *
 * Applied here, in {@link joinDaplinkDevices}, so `SerialPortInfo.path`
 * is always the open-safe path — not just at the one call site
 * (`UsbSerialLink.open()`) that happens to open the port. A student who
 * copies what's on screen into a serial terminal must see the same path
 * the app itself uses to open the device.
 */
export function toCalloutPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "darwin") {
    return path;
  }
  if (path.startsWith(DARWIN_TTY_PREFIX)) {
    return DARWIN_CU_PREFIX + path.slice(DARWIN_TTY_PREFIX.length);
  }
  return path;
}

/** `serialport`'s `vendorId`/`productId` are lowercase-hex strings (or
 * undefined), not numbers — compare numerically rather than doing a
 * case-sensitive string match. */
function hexIdMatches(value: string | undefined, expected: number): boolean {
  if (value === undefined) {
    return false;
  }
  return Number.parseInt(value, 16) === expected;
}

/**
 * Pure filter: DAPLink-matching entries from a `serialport.list()`-shaped
 * array. Unit-testable against synthetic fixtures — no real `serialport`
 * call involved.
 */
export function filterDaplinkSerialPorts(
  ports: readonly SerialPortListing[],
): SerialPortListing[] {
  return ports.filter(
    (port) =>
      hexIdMatches(port.vendorId, DAPLINK_VENDOR_ID) &&
      hexIdMatches(port.productId, DAPLINK_PRODUCT_ID),
  );
}

/**
 * Pure filter: DAPLink-matching entries from a `node-hid` `devices()`-
 * shaped array. `node-hid` reports `vendorId`/`productId` as numbers
 * already, unlike `serialport`. Unit-testable against synthetic
 * fixtures — no real `node-hid` call involved.
 */
export function filterDaplinkHidDevices(
  devices: readonly HidDeviceListing[],
): HidDeviceListing[] {
  return devices.filter(
    (device) =>
      device.vendorId === DAPLINK_VENDOR_ID && device.productId === DAPLINK_PRODUCT_ID,
  );
}

/**
 * Pure join: combine DAPLink-filtered serial-port and HID listings into
 * {@link DaplinkDevice} records keyed on shared `serialNumber`. A device
 * present on only one persona is still returned, with
 * {@link DeviceAvailability} set accordingly — never silently dropped
 * and never silently treated as fully available. A listing entry with
 * no serial number at all cannot be joined by definition and is
 * excluded (there is no key to join it on).
 */
export function joinDaplinkDevices(
  serialPorts: readonly SerialPortListing[],
  hidDevices: readonly HidDeviceListing[],
): DaplinkDevice[] {
  const bySerial = new Map<
    string,
    { serialPort?: SerialPortListing; hid?: HidDeviceListing }
  >();

  for (const port of serialPorts) {
    if (!port.serialNumber) {
      continue;
    }
    const entry = bySerial.get(port.serialNumber) ?? {};
    entry.serialPort = port;
    bySerial.set(port.serialNumber, entry);
  }

  for (const hid of hidDevices) {
    if (!hid.serialNumber) {
      continue;
    }
    const entry = bySerial.get(hid.serialNumber) ?? {};
    entry.hid = hid;
    bySerial.set(hid.serialNumber, entry);
  }

  const result: DaplinkDevice[] = [];
  for (const [serialNumber, entry] of bySerial) {
    const availability: DeviceAvailability =
      entry.serialPort && entry.hid
        ? "full"
        : entry.serialPort
          ? "serial-only"
          : "hid-only";

    result.push({
      serialNumber,
      displaySerial: shortSerialDisplay(serialNumber),
      availability,
      ...(entry.serialPort
        ? {
            serialPort: {
              path: toCalloutPath(entry.serialPort.path),
              ...(entry.serialPort.manufacturer !== undefined
                ? { manufacturer: entry.serialPort.manufacturer }
                : {}),
            },
          }
        : {}),
      ...(entry.hid
        ? {
            hid: {
              ...(entry.hid.path !== undefined ? { path: entry.hid.path } : {}),
              ...(entry.hid.product !== undefined ? { product: entry.hid.product } : {}),
            },
          }
        : {}),
    });
  }
  return result;
}

/** Function shape used to obtain a fresh device list — real enumeration
 * by default, a synthetic fixture in tests. */
export type DaplinkDeviceLister = () => Promise<DaplinkDevice[]>;

/**
 * One-shot live enumeration: list real serial ports and HID devices,
 * filter both to DAPLink's VID/PID, and join them. This is the thin
 * live wrapper around the pure functions above — not itself unit
 * tested (per the ticket, that is exercised as a manual hardware
 * smoke test), but callers/tests may still override either listing
 * function to substitute a fixture.
 */
export async function enumerateDaplinkDevices(options?: {
  listSerialPorts?: () => Promise<SerialPortListing[]>;
  listHidDevices?: () => HidDeviceListing[];
}): Promise<DaplinkDevice[]> {
  const listSerialPorts = options?.listSerialPorts ?? (() => SerialPort.list());
  const listHidDevices = options?.listHidDevices ?? (() => listHidDevicesRaw());

  const [ports, hidDevices] = await Promise.all([
    listSerialPorts(),
    Promise.resolve(listHidDevices()),
  ]);

  return joinDaplinkDevices(
    filterDaplinkSerialPorts(ports),
    filterDaplinkHidDevices(hidDevices),
  );
}

/** Result of diffing two device snapshots. */
export interface DeviceDiff {
  added: DaplinkDevice[];
  removed: DaplinkDevice[];
  /** A serial number present in both snapshots whose content changed
   * (e.g. its HID interface joined a serial-only entry, or vice versa)
   * -- see this function's own doc comment for why this is its own
   * bucket rather than a remove-then-add pair. */
  updated: DaplinkDevice[];
}

/** Options controlling how {@link diffDaplinkDevices} (and
 * {@link DeviceWatcher}) report a same-serial content change. */
export interface DiffDaplinkDevicesOptions {
  /**
   * When `true`, a device whose serial number persists across the diff
   * but whose content changed (e.g. its HID interface appeared after
   * its serial port was already present -- the common case: a board's
   * two USB personas rarely finish enumerating in the same poll) is
   * reported in {@link DeviceDiff.updated}, not as a remove-then-add
   * pair (ticket 014-007 / review `01-host-device-model.md` S2.1: the
   * old remove+add modeling caused two SWD reads, two port opens --
   * two resets on macOS -- and two `HELLO`s per attach).
   *
   * Defaults to `false` -- the legacy remove+add behaviour -- because
   * `deviceRegistry.ts`'s older watcher-driven attach/detach path
   * ({@link DeviceChangeEvent}'s `removed`/`added` handling) relies on
   * seeing a `removed` entry to abandon in-flight work against a
   * now-stale state object (its "orphaned state during a flash" guard,
   * ticket 014-010). That path does not (yet) look at `updated` at
   * all, so silently switching the default out from under it drops the
   * guard on the floor. `usbWatcher.ts` (ticket 014-007/008), which
   * *does* understand `updated` ("refresh address, keep everything
   * else unchanged" -- never re-running SWD naming or identify for
   * it), opts in explicitly.
   */
  reportUpdatedInPlace?: boolean;
}

/**
 * Pure diff between two {@link DaplinkDevice} snapshots, keyed by
 * `serialNumber`. By default a device whose serial number persists but
 * whose content changed is reported as a remove-then-add pair (see
 * {@link DiffDaplinkDevicesOptions.reportUpdatedInPlace} for why, and
 * how to opt into the `updated` bucket instead).
 */
export function diffDaplinkDevices(
  previous: readonly DaplinkDevice[],
  next: readonly DaplinkDevice[],
  options?: DiffDaplinkDevicesOptions,
): DeviceDiff {
  const reportUpdatedInPlace = options?.reportUpdatedInPlace ?? false;
  const previousBySerial = new Map(previous.map((d) => [d.serialNumber, d] as const));
  const nextBySerial = new Map(next.map((d) => [d.serialNumber, d] as const));

  const added: DaplinkDevice[] = [];
  const removed: DaplinkDevice[] = [];
  const updated: DaplinkDevice[] = [];

  for (const [serialNumber, device] of nextBySerial) {
    const previousDevice = previousBySerial.get(serialNumber);
    if (!previousDevice) {
      added.push(device);
    } else if (JSON.stringify(previousDevice) !== JSON.stringify(device)) {
      if (reportUpdatedInPlace) {
        updated.push(device);
      } else {
        removed.push(previousDevice);
        added.push(device);
      }
    }
  }
  for (const [serialNumber, device] of previousBySerial) {
    if (!nextBySerial.has(serialNumber)) {
      removed.push(device);
    }
  }

  return { added, removed, updated };
}

/** Snapshot + diff delivered to {@link DeviceChangeListener}s. */
export interface DeviceChangeEvent {
  added: readonly DaplinkDevice[];
  removed: readonly DaplinkDevice[];
  updated: readonly DaplinkDevice[];
  current: readonly DaplinkDevice[];
}

export type DeviceChangeListener = (event: DeviceChangeEvent) => void;

export interface DeviceWatcherOptions {
  /** How to obtain a fresh device list on each poll. Defaults to
   * {@link enumerateDaplinkDevices} (real hardware). Tests/callers
   * inject a fixture-backed lister to run with no hardware attached. */
  listDevices?: DaplinkDeviceLister;
  /** Poll interval in ms when {@link DeviceWatcher.start} is used.
   * Defaults to 1000. Irrelevant if callers drive
   * {@link DeviceWatcher.pollOnce} themselves. */
  pollIntervalMs?: number;
  /** Forwarded to {@link diffDaplinkDevices} on every poll -- see
   * {@link DiffDaplinkDevicesOptions.reportUpdatedInPlace} for the
   * default and why `deviceRegistry.ts`'s consumers should leave this
   * unset. */
  reportUpdatedInPlace?: boolean;
}

const DEFAULT_POLL_INTERVAL_MS = 1000;

/**
 * Live layer over the pure enumerate/diff functions above: polls on an
 * interval and notifies listeners of what was added/removed since the
 * last poll, so `server.ts` (ticket 009) can push live "device plugged
 * in / unplugged" updates to the UI instead of only a snapshot at
 * startup. Poll-and-diff rather than `serialport`'s own attach/detach
 * events, since it also covers the HID side (which has no comparable
 * event source) with one mechanism.
 *
 * `pollOnce()` is exposed directly (not just via `start()`/an internal
 * timer) so callers — and unit tests — can drive the diff
 * deterministically without depending on real timers.
 */
export class DeviceWatcher {
  private readonly listDevices: DaplinkDeviceLister;
  private readonly pollIntervalMs: number;
  private readonly reportUpdatedInPlace: boolean;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly listeners = new Set<DeviceChangeListener>();
  private currentDevices: DaplinkDevice[] = [];

  constructor(options: DeviceWatcherOptions = {}) {
    this.listDevices = options.listDevices ?? enumerateDaplinkDevices;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.reportUpdatedInPlace = options.reportUpdatedInPlace ?? false;
  }

  /** Devices as of the most recent poll (`[]` before the first poll). */
  current(): readonly DaplinkDevice[] {
    return this.currentDevices;
  }

  /** Subscribe to change events. Returns an unsubscribe function. */
  onChange(listener: DeviceChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Run one poll immediately: fetch a fresh list, diff it against the
   * previous snapshot, update the snapshot, and notify listeners only
   * if something actually changed. Returns the event either way so
   * callers/tests can inspect it without a listener.
   */
  async pollOnce(): Promise<DeviceChangeEvent> {
    const next = await this.listDevices();
    const { added, removed, updated } = diffDaplinkDevices(this.currentDevices, next, {
      reportUpdatedInPlace: this.reportUpdatedInPlace,
    });
    this.currentDevices = next;
    const event: DeviceChangeEvent = { added, removed, updated, current: next };
    if (added.length > 0 || removed.length > 0 || updated.length > 0) {
      for (const listener of this.listeners) {
        listener(event);
      }
    }
    return event;
  }

  /** Start polling on `pollIntervalMs`. No-op if already started. */
  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
    // Don't let the poll timer keep the process alive on its own.
    this.timer.unref?.();
  }

  /** Stop polling. No-op if not started. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
