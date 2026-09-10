import { describe, expect, it } from "vitest";
import { gateWifiRobots } from "./wifiRobotGate.js";
import type { WifiRobotService } from "../discovery/mdnsDiscovery.js";
import type { KnownRobotRecord } from "../store/knownRobots.js";

function wifiRobot(name: string): WifiRobotService {
  return {
    name,
    host: `${name}.local.`,
    port: 7654,
    role: "robot",
    link: "v6",
  };
}

function rosterRecord(name: string): KnownRobotRecord {
  return {
    name,
    firstSeenAt: "2026-09-01T00:00:00.000Z",
    lastSeenAt: "2026-09-01T00:00:00.000Z",
    lastSeenVia: "usb",
    lastUsbSerial: "0000000012345678",
    lastRole: "NEZHA2",
    lastType: "robot",
  };
}

describe("gateWifiRobots", () => {
  it("returns a discovered robot whose name is in the roster", () => {
    const result = gateWifiRobots([wifiRobot("gopiv")], [rosterRecord("gopiv")]);
    expect(result).toEqual([wifiRobot("gopiv")]);
  });

  it("excludes a discovered robot whose name is not in the roster (the sprint's core privacy guarantee)", () => {
    const result = gateWifiRobots([wifiRobot("vevov")], [rosterRecord("gopiv")]);
    expect(result).toEqual([]);
  });

  it("returns only the roster-matched subset when discovery mixes matched and unmatched names", () => {
    const result = gateWifiRobots(
      [wifiRobot("gopiv"), wifiRobot("vevov")],
      [rosterRecord("gopiv")],
    );
    expect(result).toEqual([wifiRobot("gopiv")]);
  });

  it("returns [] for an empty roster with a non-empty discovery list", () => {
    const result = gateWifiRobots([wifiRobot("gopiv")], []);
    expect(result).toEqual([]);
  });

  it("returns [] for an empty discovery list with a non-empty roster", () => {
    const result = gateWifiRobots([], [rosterRecord("gopiv")]);
    expect(result).toEqual([]);
  });

  it("returns [] when both inputs are empty", () => {
    const result = gateWifiRobots([], []);
    expect(result).toEqual([]);
  });
});
