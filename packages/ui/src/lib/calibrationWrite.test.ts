/**
 * calibrationWrite.test.ts — the unit conversion and the skip rules.
 *
 * The 10x track-width case is the one this file exists for: this
 * console's state is in cm, the wire field is in mm, and nothing in
 * either protocol would reject the wrong one. See `calibrationWrite.ts`'s
 * own doc comment.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildCalibrationWrites,
  describeCalibrationWrites,
  writeCalibration,
} from "./calibrationWrite";
import type { CalibrationState } from "./calibration";

const FULL: CalibrationState = {
  wheelDiameterMm: 81.45,
  measuredTrackWidthCm: 12.85,
  reportedTrackWidthCm: 11.67,
  reportedWithDiameterMm: 90.28,
  firmwareSlip: 1.101,
};

describe("buildCalibrationWrites", () => {
  it("converts track width from the console's cm to the wire's mm", () => {
    const writes = buildCalibrationWrites(FULL);
    const trackWidth = writes.find((write) => write.name === "track_width");
    expect(trackWidth).toEqual({
      key: "trackWidth",
      name: "track_width",
      value: 128.5,
      unit: "mm",
    });
  });

  it("rounds away the float noise in cm*10 rather than sending it", () => {
    // 140 of the 600 two-decimal cm values between 10.00 and 16.00 --
    // roughly one track width in four -- have an inexact `* 10` in IEEE
    // 754. 12.52 is one: the raw product is 125.19999999999999, and
    // that is what String() would put on the wire and what a GET would
    // read back to a human.
    expect(12.52 * 10).not.toBe(125.2);
    const writes = buildCalibrationWrites({ ...FULL, measuredTrackWidthCm: 12.52 });
    expect(writes.find((write) => write.name === "track_width")?.value).toBe(125.2);
  });

  it("sends wheel diameter in mm unconverted", () => {
    const writes = buildCalibrationWrites(FULL);
    expect(writes.find((write) => write.name === "wheel_diameter")?.value).toBe(81.45);
  });

  it("prefers the robot's own firmwareSlip over the console's derived slip", () => {
    const writes = buildCalibrationWrites(FULL);
    expect(writes.find((write) => write.name === "rotational_slip")?.value).toBe(1.101);
  });

  it("falls back to the derived slip when no calturn run reported one", () => {
    const { firmwareSlip: _unused, ...withoutFirmwareSlip } = FULL;
    const writes = buildCalibrationWrites(withoutFirmwareSlip);
    const slip = writes.find((write) => write.name === "rotational_slip")?.value;
    expect(slip).toBeGreaterThan(0);
    expect(slip).not.toBe(1.101);
  });

  it("writes wheel diameter before the two turn values", () => {
    // A robot that takes only the first write is left consistent: slip
    // and track width describe a turn made on a particular wheel.
    expect(buildCalibrationWrites(FULL).map((write) => write.name)).toEqual([
      "wheel_diameter",
      "track_width",
      "rotational_slip",
    ]);
  });

  it("omits what this session has no value for, rather than refusing", () => {
    expect(buildCalibrationWrites({ wheelDiameterMm: 81.45 })).toEqual([
      { key: "wheelDiameter", name: "wheel_diameter", value: 81.45, unit: "mm" },
    ]);
  });

  it("returns nothing for an empty calibration", () => {
    expect(buildCalibrationWrites({})).toEqual([]);
  });

  it("drops a non-positive value instead of sending a write the firmware silently ignores", () => {
    // All three fields are ">0, else keep" in shims.cpp, so a 0 would
    // ack as success and change nothing.
    expect(buildCalibrationWrites({ wheelDiameterMm: 0, measuredTrackWidthCm: 0 })).toEqual([]);
  });
});

describe("writeCalibration", () => {
  it("sends one sequenced SET per write, then persists with RUN calsave", () => {
    const sendCommand = vi.fn();
    const writes = buildCalibrationWrites(FULL);
    const sent = writeCalibration(sendCommand, "link-1", writes);

    expect(sendCommand.mock.calls).toEqual([
      ["link-1", "SET", ["wheel_diameter", "81.45"]],
      ["link-1", "SET", ["track_width", "128.5"]],
      ["link-1", "SET", ["rotational_slip", "1.101"]],
      // calsave takes CENTIMETRES -- it is a program on the robot
      // calling setTrackWidth() -- while the SET above takes mm.
      ["link-1", "RUN", ["calsave", "81.45", "12.85", "1.101"]],
    ]);
    expect(sent).toEqual(writes);
  });

  it("pads a skipped value with calsave's own zero rather than shifting the rest", () => {
    // calsave's arguments are positional and 0 means "leave it alone",
    // so a missing slip must not slide the track width into its place.
    const { firmwareSlip: _a, reportedTrackWidthCm: _b, ...wheelAndTrackOnly } = FULL;
    const sendCommand = vi.fn();
    writeCalibration(sendCommand, "link-1", buildCalibrationWrites(wheelAndTrackOnly));
    expect(sendCommand.mock.calls.at(-1)).toEqual([
      "link-1",
      "RUN",
      ["calsave", "81.45", "12.85", "0"],
    ]);
  });

  it("persists a wheel-only write with two zeros", () => {
    const sendCommand = vi.fn();
    writeCalibration(sendCommand, "link-1", buildCalibrationWrites({ wheelDiameterMm: 81.45 }));
    expect(sendCommand.mock.calls).toEqual([
      ["link-1", "SET", ["wheel_diameter", "81.45"]],
      ["link-1", "RUN", ["calsave", "81.45", "0", "0"]],
    ]);
  });

  it("sends nothing at all -- not even calsave -- when there is nothing to write", () => {
    const sendCommand = vi.fn();
    expect(writeCalibration(sendCommand, "link-1", buildCalibrationWrites({}))).toEqual([]);
    expect(sendCommand).not.toHaveBeenCalled();
  });
});

describe("describeCalibrationWrites", () => {
  it("names each field with its wire unit, and leaves slip unitless", () => {
    expect(describeCalibrationWrites(buildCalibrationWrites(FULL))).toBe(
      "wheel_diameter 81.45 mm, track_width 128.5 mm, rotational_slip 1.101",
    );
  });

  it("is empty when nothing was written", () => {
    expect(describeCalibrationWrites([])).toBe("");
  });
});
