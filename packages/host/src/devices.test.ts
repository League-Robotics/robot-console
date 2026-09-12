import { describe, expect, it, vi } from "vitest";
import {
  DeviceWatcher,
  diffDaplinkDevices,
  filterDaplinkHidDevices,
  filterDaplinkSerialPorts,
  joinDaplinkDevices,
  shortSerialDisplay,
  toCalloutPath,
  type DaplinkDevice,
  type HidInterfaceInfo,
  type SerialPortInfo,
} from "./devices.js";
import type { Device as HidDeviceListing } from "node-hid";
import type { SerialPortListing } from "./devices.js";

/** Minimal DAPLink-shaped `serialport.list()` entry, with everything
 * `PortInfo` requires beyond `path` defaulted to undefined unless
 * overridden. */
function fakeSerialPort(overrides: Partial<SerialPortListing> & { path: string }): SerialPortListing {
  return {
    manufacturer: undefined,
    serialNumber: undefined,
    pnpId: undefined,
    locationId: undefined,
    productId: undefined,
    vendorId: undefined,
    ...overrides,
  };
}

/** Minimal DAPLink-shaped `node-hid` `devices()` entry. */
function fakeHidDevice(overrides: Partial<HidDeviceListing> & {
  vendorId: number;
  productId: number;
}): HidDeviceListing {
  return {
    release: 0x0100,
    interface: 0,
    path: undefined,
    serialNumber: undefined,
    manufacturer: undefined,
    product: undefined,
    usagePage: undefined,
    usage: undefined,
    ...overrides,
  };
}

// Two synthetic boards sharing the same interface-chip prefix/suffix
// (as real DAPLink boards on one bench do), differing only in the
// board-unique middle field. 16 + 16 + 16 = 48 hex chars, matching the
// documented `board+family+hic / unique / pad+hic` shape.
const SHARED_PREFIX = "9900000031864e45";
const SHARED_SUFFIX = "0000000000000001";
const SERIAL_BOARD_A = `${SHARED_PREFIX}1111111111111111${SHARED_SUFFIX}`;
const SERIAL_BOARD_B = `${SHARED_PREFIX}2222222222222222${SHARED_SUFFIX}`;

// ---------------------------------------------------------------------
// toCalloutPath (moved here from `link/UsbSerialLink.test.ts` per
// sprint 003 ticket 001 -- see this module's `toCalloutPath` doc
// comment for why the translation now lives in `devices.ts`)
// ---------------------------------------------------------------------

describe("toCalloutPath", () => {
  it("translates a macOS tty. path to its cu. counterpart", () => {
    expect(toCalloutPath("/dev/tty.usbmodem2121102", "darwin")).toBe(
      "/dev/cu.usbmodem2121102",
    );
  });

  it("leaves an already-cu. path unchanged on darwin", () => {
    expect(toCalloutPath("/dev/cu.usbmodem2121102", "darwin")).toBe(
      "/dev/cu.usbmodem2121102",
    );
  });

  it("leaves a Linux-shaped path unchanged", () => {
    expect(toCalloutPath("/dev/ttyACM0", "linux")).toBe("/dev/ttyACM0");
  });

  it("leaves a non-serial path unchanged on darwin (no tty. prefix)", () => {
    expect(toCalloutPath("/dev/something-else", "darwin")).toBe(
      "/dev/something-else",
    );
  });
});

describe("filterDaplinkSerialPorts", () => {
  it("keeps only entries matching DAPLink's VID/PID (case-insensitive hex)", () => {
    const daplink = fakeSerialPort({
      path: "/dev/cu.usbmodem1101",
      vendorId: "0D28",
      productId: "0204",
      serialNumber: SERIAL_BOARD_A,
    });
    const other = fakeSerialPort({
      path: "/dev/cu.usbserial-FT1",
      vendorId: "0403",
      productId: "6001",
      serialNumber: "AB12CD34",
    });

    const result = filterDaplinkSerialPorts([daplink, other]);

    expect(result).toEqual([daplink]);
  });

  it("excludes entries with no vendor/product id at all", () => {
    const noIds = fakeSerialPort({ path: "/dev/cu.mystery" });
    expect(filterDaplinkSerialPorts([noIds])).toEqual([]);
  });
});

describe("filterDaplinkHidDevices", () => {
  it("keeps only entries matching DAPLink's numeric VID/PID", () => {
    const daplink = fakeHidDevice({
      vendorId: 0x0d28,
      productId: 0x0204,
      path: "IOHIDDevice@abc",
      serialNumber: SERIAL_BOARD_A,
    });
    const other = fakeHidDevice({ vendorId: 0x046d, productId: 0xc52b });

    expect(filterDaplinkHidDevices([daplink, other])).toEqual([daplink]);
  });
});

describe("joinDaplinkDevices", () => {
  it("joins two boards correctly on their shared serial number", () => {
    const portA = fakeSerialPort({
      path: "/dev/cu.usbmodemA",
      vendorId: "0d28",
      productId: "0204",
      serialNumber: SERIAL_BOARD_A,
    });
    const portB = fakeSerialPort({
      path: "/dev/cu.usbmodemB",
      vendorId: "0d28",
      productId: "0204",
      serialNumber: SERIAL_BOARD_B,
    });
    const hidA = fakeHidDevice({
      vendorId: 0x0d28,
      productId: 0x0204,
      path: "IOHIDDevice@A",
      serialNumber: SERIAL_BOARD_A,
    });
    const hidB = fakeHidDevice({
      vendorId: 0x0d28,
      productId: 0x0204,
      path: "IOHIDDevice@B",
      serialNumber: SERIAL_BOARD_B,
    });

    const result = joinDaplinkDevices([portA, portB], [hidA, hidB]);

    expect(result).toHaveLength(2);
    const bySerial = new Map(result.map((d) => [d.serialNumber, d]));

    const joinedA = bySerial.get(SERIAL_BOARD_A);
    expect(joinedA?.availability).toBe("full");
    expect(joinedA?.serialPort).toEqual<SerialPortInfo>({ path: "/dev/cu.usbmodemA" });
    expect(joinedA?.hid).toEqual<HidInterfaceInfo>({ path: "IOHIDDevice@A" });

    const joinedB = bySerial.get(SERIAL_BOARD_B);
    expect(joinedB?.availability).toBe("full");
    expect(joinedB?.serialPort?.path).toBe("/dev/cu.usbmodemB");
    expect(joinedB?.hid?.path).toBe("IOHIDDevice@B");
  });

  it("surfaces a board present on serial but not HID as serial-only, not dropped or full", () => {
    const port = fakeSerialPort({
      path: "/dev/cu.usbmodemC",
      vendorId: "0d28",
      productId: "0204",
      serialNumber: SERIAL_BOARD_A,
    });

    const result = joinDaplinkDevices([port], []);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      serialNumber: SERIAL_BOARD_A,
      availability: "serial-only",
      serialPort: { path: "/dev/cu.usbmodemC" },
    });
    expect(result[0]?.hid).toBeUndefined();
  });

  it("surfaces a board present on HID but not serial as hid-only, not dropped or full", () => {
    const hid = fakeHidDevice({
      vendorId: 0x0d28,
      productId: 0x0204,
      path: "IOHIDDevice@D",
      serialNumber: SERIAL_BOARD_B,
    });

    const result = joinDaplinkDevices([], [hid]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      serialNumber: SERIAL_BOARD_B,
      availability: "hid-only",
      hid: { path: "IOHIDDevice@D" },
    });
    expect(result[0]?.serialPort).toBeUndefined();
  });

  it("excludes a non-micro:bit serial port that was never DAPLink-filtered", () => {
    // Simulates the end-to-end shape: filter first, then join. A
    // non-DAPLink port passed straight to join (skipping the filter)
    // would still join if it happened to carry a serial number — the
    // exclusion responsibility belongs to the filter step, exercised
    // here by running both together.
    const daplink = fakeSerialPort({
      path: "/dev/cu.usbmodemE",
      vendorId: "0d28",
      productId: "0204",
      serialNumber: SERIAL_BOARD_A,
    });
    const ftdi = fakeSerialPort({
      path: "/dev/cu.usbserial-FTDI",
      vendorId: "0403",
      productId: "6001",
      serialNumber: "NOT-A-MICROBIT",
    });

    const result = joinDaplinkDevices(filterDaplinkSerialPorts([daplink, ftdi]), []);

    expect(result).toHaveLength(1);
    expect(result[0]?.serialNumber).toBe(SERIAL_BOARD_A);
  });

  it("stores the translated cu. path, not the raw tty. path, for a darwin-shaped serial port", () => {
    // Forces "darwin" on `toCalloutPath` for determinism regardless of
    // the platform running the test (the ticket's acceptance criterion:
    // `SerialPortInfo.path` must be the *translated* path, not whatever
    // `serialport` reported verbatim).
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const port = fakeSerialPort({
        path: "/dev/tty.usbmodemXXXX",
        vendorId: "0d28",
        productId: "0204",
        serialNumber: SERIAL_BOARD_A,
      });

      const result = joinDaplinkDevices([port], []);

      expect(result).toHaveLength(1);
      expect(result[0]?.serialPort?.path).toBe("/dev/cu.usbmodemXXXX");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("cannot join, and excludes, a listing entry with no serial number", () => {
    const keyless = fakeSerialPort({
      path: "/dev/cu.usbmodemF",
      vendorId: "0d28",
      productId: "0204",
      // no serialNumber
    });
    expect(joinDaplinkDevices([keyless], [])).toEqual([]);
  });
});

describe("shortSerialDisplay (shared-prefix/suffix UID trap)", () => {
  it("produces distinct display names for two serials sharing a prefix and suffix", () => {
    const displayA = shortSerialDisplay(SERIAL_BOARD_A);
    const displayB = shortSerialDisplay(SERIAL_BOARD_B);

    // Sanity: the two synthetic serials really do share the trap shape
    // (identical front 16 and back 16 chars) before asserting anything
    // about how we derive the display form from them.
    expect(SERIAL_BOARD_A.slice(0, 16)).toBe(SERIAL_BOARD_B.slice(0, 16));
    expect(SERIAL_BOARD_A.slice(-16)).toBe(SERIAL_BOARD_B.slice(-16));

    expect(displayA).toBe("1111111111111111");
    expect(displayB).toBe("2222222222222222");
    expect(displayA).not.toBe(displayB);
  });

  it("falls back to the full string for a serial shorter than the expected DAPLink shape", () => {
    expect(shortSerialDisplay("shortserial")).toBe("shortserial");
  });
});

describe("diffDaplinkDevices", () => {
  function device(overrides: Partial<DaplinkDevice> & { serialNumber: string }): DaplinkDevice {
    return {
      displaySerial: shortSerialDisplay(overrides.serialNumber),
      availability: "full",
      ...overrides,
    };
  }

  it("reports an attached board as added", () => {
    const a = device({ serialNumber: SERIAL_BOARD_A });
    const { added, removed } = diffDaplinkDevices([], [a]);
    expect(added).toEqual([a]);
    expect(removed).toEqual([]);
  });

  it("reports an unplugged board as removed", () => {
    const a = device({ serialNumber: SERIAL_BOARD_A });
    const { added, removed } = diffDaplinkDevices([a], []);
    expect(added).toEqual([]);
    expect(removed).toEqual([a]);
  });

  it("reports no change when the snapshot is identical", () => {
    const a = device({ serialNumber: SERIAL_BOARD_A });
    const { added, removed } = diffDaplinkDevices([a], [{ ...a }]);
    expect(added).toEqual([]);
    expect(removed).toEqual([]);
  });

  it("reports a same-serial content change as a remove+add pair by default (legacy behaviour) -- ticket 014-010", () => {
    const partial = device({ serialNumber: SERIAL_BOARD_A, availability: "serial-only" });
    const full = device({ serialNumber: SERIAL_BOARD_A, availability: "full" });
    const { added, removed, updated } = diffDaplinkDevices([partial], [full]);
    expect(added).toEqual([full]);
    expect(removed).toEqual([partial]);
    expect(updated).toEqual([]);
  });

  it("reports an update (not a remove+add pair) when a board's availability changes in place and reportUpdatedInPlace is set -- ticket 014-007/010", () => {
    const partial = device({ serialNumber: SERIAL_BOARD_A, availability: "serial-only" });
    const full = device({ serialNumber: SERIAL_BOARD_A, availability: "full" });
    const { added, removed, updated } = diffDaplinkDevices([partial], [full], {
      reportUpdatedInPlace: true,
    });
    expect(added).toEqual([]);
    expect(removed).toEqual([]);
    expect(updated).toEqual([full]);
  });

  it("reports no update, add, or remove when the snapshot is identical (updated bucket, reportUpdatedInPlace set)", () => {
    const a = device({ serialNumber: SERIAL_BOARD_A });
    const { added, removed, updated } = diffDaplinkDevices([a], [{ ...a }], {
      reportUpdatedInPlace: true,
    });
    expect(added).toEqual([]);
    expect(removed).toEqual([]);
    expect(updated).toEqual([]);
  });
});

describe("DeviceWatcher", () => {
  function device(overrides: Partial<DaplinkDevice> & { serialNumber: string }): DaplinkDevice {
    return {
      displaySerial: shortSerialDisplay(overrides.serialNumber),
      availability: "full",
      ...overrides,
    };
  }

  it("notifies listeners with the diff on a poll that changes the snapshot", async () => {
    const a = device({ serialNumber: SERIAL_BOARD_A });
    const listDevices = vi.fn<() => Promise<DaplinkDevice[]>>().mockResolvedValueOnce([a]);
    const watcher = new DeviceWatcher({ listDevices });
    const listener = vi.fn();
    watcher.onChange(listener);

    const event = await watcher.pollOnce();

    expect(event.added).toEqual([a]);
    expect(event.removed).toEqual([]);
    expect(event.current).toEqual([a]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(event);
    expect(watcher.current()).toEqual([a]);
  });

  it("does not notify listeners when a poll finds no change", async () => {
    const a = device({ serialNumber: SERIAL_BOARD_A });
    const listDevices = vi.fn<() => Promise<DaplinkDevice[]>>().mockResolvedValue([a]);
    const watcher = new DeviceWatcher({ listDevices });
    const listener = vi.fn();

    await watcher.pollOnce();
    watcher.onChange(listener);
    await watcher.pollOnce();

    expect(listener).not.toHaveBeenCalled();
  });

  it("reports a same-serial content change as remove+add by default (legacy behaviour) -- ticket 014-010", async () => {
    const partial = device({ serialNumber: SERIAL_BOARD_A, availability: "serial-only" });
    const full = device({ serialNumber: SERIAL_BOARD_A, availability: "full" });
    const listDevices = vi
      .fn<() => Promise<DaplinkDevice[]>>()
      .mockResolvedValueOnce([partial])
      .mockResolvedValueOnce([full]);
    const watcher = new DeviceWatcher({ listDevices });
    await watcher.pollOnce();
    const listener = vi.fn();
    watcher.onChange(listener);

    const event = await watcher.pollOnce();

    expect(event.added).toEqual([full]);
    expect(event.removed).toEqual([partial]);
    expect(event.updated).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(event);
  });

  it("notifies listeners on an updated-only diff (no added/removed) when reportUpdatedInPlace is set -- ticket 014-007/010", async () => {
    const partial = device({ serialNumber: SERIAL_BOARD_A, availability: "serial-only" });
    const full = device({ serialNumber: SERIAL_BOARD_A, availability: "full" });
    const listDevices = vi
      .fn<() => Promise<DaplinkDevice[]>>()
      .mockResolvedValueOnce([partial])
      .mockResolvedValueOnce([full]);
    const watcher = new DeviceWatcher({ listDevices, reportUpdatedInPlace: true });
    await watcher.pollOnce();
    const listener = vi.fn();
    watcher.onChange(listener);

    const event = await watcher.pollOnce();

    expect(event.added).toEqual([]);
    expect(event.removed).toEqual([]);
    expect(event.updated).toEqual([full]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(event);
  });

  it("stops notifying an unsubscribed listener", async () => {
    const a = device({ serialNumber: SERIAL_BOARD_A });
    const listDevices = vi
      .fn<() => Promise<DaplinkDevice[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([a]);
    const watcher = new DeviceWatcher({ listDevices });
    const listener = vi.fn();
    const unsubscribe = watcher.onChange(listener);
    unsubscribe();

    await watcher.pollOnce();
    await watcher.pollOnce();

    expect(listener).not.toHaveBeenCalled();
  });
});
