import { describe, expect, it } from "vitest";
import { findDeviceForCalloutPath } from "./hidReset.js";
import type { DaplinkDevice } from "../../../packages/host/dist/devices.js";

const device = (over: Partial<DaplinkDevice> = {}): DaplinkDevice => ({
  serialNumber: "9906360200052820...",
  displaySerial: "0005282089",
  availability: "full",
  serialPort: { path: "/dev/cu.usbmodem2121402" },
  hid: { path: "IOService:/AppleUSB.../IOUSBHostDevice@.../IOUSBHostInterface@0" },
  ...over,
});

describe("findDeviceForCalloutPath (018-003 vevav HID-reset opt-in)", () => {
  it("finds the joined device whose serial-port callout path matches", () => {
    const devices = [device({ serialPort: { path: "/dev/cu.usbmodem2121102" } }), device({ serialPort: { path: "/dev/cu.usbmodem2121402" } })];
    const found = findDeviceForCalloutPath(devices, "/dev/cu.usbmodem2121402");
    expect(found?.serialPort?.path).toBe("/dev/cu.usbmodem2121402");
  });

  it("returns undefined when no device matches", () => {
    const devices = [device({ serialPort: { path: "/dev/cu.usbmodem2121102" } })];
    expect(findDeviceForCalloutPath(devices, "/dev/cu.usbmodem2121402")).toBeUndefined();
  });

  it("skips a device with no serial-port half at all (hid-only availability)", () => {
    const devices = [device({ serialPort: undefined, availability: "hid-only" })];
    expect(findDeviceForCalloutPath(devices, "/dev/cu.usbmodem2121402")).toBeUndefined();
  });
});
