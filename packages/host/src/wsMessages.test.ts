import { describe, expect, it } from "vitest";
import { parseClientMessage } from "./wsMessages.js";
import type { DeviceListEntry } from "./wsMessages.js";

describe("parseClientMessage", () => {
  it("accepts a well-formed open message", () => {
    expect(parseClientMessage({ type: "open", deviceId: "abc" })).toEqual({
      type: "open",
      deviceId: "abc",
    });
  });

  it("accepts a well-formed close message", () => {
    expect(parseClientMessage({ type: "close", deviceId: "abc" })).toEqual({
      type: "close",
      deviceId: "abc",
    });
  });

  it("accepts a well-formed outbound line message", () => {
    expect(
      parseClientMessage({ type: "line", deviceId: "abc", direction: "tx", line: "HELLO" }),
    ).toEqual({ type: "line", deviceId: "abc", direction: "tx", line: "HELLO" });
  });

  it("rejects a line message claiming direction rx from a client (server-only direction)", () => {
    expect(
      parseClientMessage({ type: "line", deviceId: "abc", direction: "rx", line: "HELLO" }),
    ).toBeUndefined();
  });

  it("accepts a well-formed flash-start message for the relay firmware", () => {
    expect(parseClientMessage({ type: "flash-start", deviceId: "abc", firmware: "relay" })).toEqual({
      type: "flash-start",
      deviceId: "abc",
      firmware: "relay",
    });
  });

  it("accepts a well-formed flash-start message for the robot firmware", () => {
    expect(parseClientMessage({ type: "flash-start", deviceId: "abc", firmware: "robot" })).toEqual({
      type: "flash-start",
      deviceId: "abc",
      firmware: "robot",
    });
  });

  it.each([
    ["not an object", "nope"],
    ["null", null],
    ["missing type", {}],
    ["unknown type", { type: "flarp", deviceId: "abc" }],
    ["open with no deviceId", { type: "open" }],
    ["open with empty deviceId", { type: "open", deviceId: "" }],
    ["open with non-string deviceId", { type: "open", deviceId: 5 }],
    ["line missing line field", { type: "line", deviceId: "abc", direction: "tx" }],
    ["line with non-string line field", { type: "line", deviceId: "abc", direction: "tx", line: 5 }],
    ["flash-start with no deviceId", { type: "flash-start", firmware: "relay" }],
    ["flash-start with empty deviceId", { type: "flash-start", deviceId: "", firmware: "relay" }],
    ["flash-start with non-string deviceId", { type: "flash-start", deviceId: 5, firmware: "relay" }],
    ["flash-start with no firmware", { type: "flash-start", deviceId: "abc" }],
    ["flash-start with invalid firmware value", { type: "flash-start", deviceId: "abc", firmware: "relayx" }],
  ])("rejects: %s", (_label, value) => {
    expect(parseClientMessage(value)).toBeUndefined();
  });
});

describe("DeviceListEntry", () => {
  it("still round-trips as a valid DeviceListEntry when flashStatus is absent (pre-sprint-2 shape)", () => {
    // Type-level fixture: this compiles only if `flashStatus` is optional,
    // proving the new field is additive and doesn't break a snapshot that
    // predates it -- see the ticket's testing plan.
    const entry: DeviceListEntry = {
      id: "SERIAL-A",
      serialNumber: "SERIAL-A",
      displaySerial: "SHORT-A",
      name: "zeguz",
      role: "NEZHA2",
      port: "/dev/cu.usbmodemA",
      linkOpen: true,
    };
    expect(entry.flashStatus).toBeUndefined();
  });
});
