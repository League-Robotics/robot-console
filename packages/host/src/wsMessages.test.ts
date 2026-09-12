import { describe, expect, it } from "vitest";
import { parseClientMessage } from "./wsMessages.js";
import type { ServerMessage, TelemetryMessage } from "./wsMessages.js";

describe("parseClientMessage", () => {
  describe("session-open", () => {
    it("accepts the {linkId} shape", () => {
      expect(parseClientMessage({ type: "session-open", linkId: "usb-abc" })).toEqual({
        type: "session-open",
        linkId: "usb-abc",
      });
    });

    it("accepts the {relayLinkId, name} shape", () => {
      expect(
        parseClientMessage({ type: "session-open", relayLinkId: "relay-1", name: "zeguz" }),
      ).toEqual({ type: "session-open", relayLinkId: "relay-1", name: "zeguz" });
    });

    it("rejects a message carrying both linkId and relayLinkId (mutually exclusive shapes)", () => {
      expect(
        parseClientMessage({ type: "session-open", linkId: "usb-abc", relayLinkId: "relay-1", name: "zeguz" }),
      ).toBeUndefined();
    });

    it("rejects a message carrying neither shape", () => {
      expect(parseClientMessage({ type: "session-open" })).toBeUndefined();
    });

    it("rejects relayLinkId with no name", () => {
      expect(parseClientMessage({ type: "session-open", relayLinkId: "relay-1" })).toBeUndefined();
    });

    it("rejects name with no relayLinkId", () => {
      expect(parseClientMessage({ type: "session-open", name: "zeguz" })).toBeUndefined();
    });

    it("rejects a radio override field -- that argument no longer exists on this message (ticket 006 replaces it with set-radio-override)", () => {
      // The parser only ever reads linkId/relayLinkId/name off the wire,
      // so a rogue `radio` property is silently dropped rather than
      // rejected -- asserting here that it never surfaces on the parsed
      // result, which is what actually matters (the type has no `radio`
      // field for a caller to read).
      const parsed = parseClientMessage({
        type: "session-open",
        relayLinkId: "relay-1",
        name: "zeguz",
        radio: { channel: 41, group: 3 },
      });
      expect(parsed).toEqual({ type: "session-open", relayLinkId: "relay-1", name: "zeguz" });
      expect(parsed).not.toHaveProperty("radio");
    });

    it("rejects a non-string linkId", () => {
      expect(parseClientMessage({ type: "session-open", linkId: 5 })).toBeUndefined();
    });

    it("rejects an empty-string linkId", () => {
      expect(parseClientMessage({ type: "session-open", linkId: "" })).toBeUndefined();
    });
  });

  describe("session-close", () => {
    it("accepts a well-formed message", () => {
      expect(parseClientMessage({ type: "session-close", linkId: "usb-abc" })).toEqual({
        type: "session-close",
        linkId: "usb-abc",
      });
    });

    it("rejects a message with no linkId", () => {
      expect(parseClientMessage({ type: "session-close" })).toBeUndefined();
    });
  });

  it("accepts a well-formed outbound line message", () => {
    expect(
      parseClientMessage({ type: "line", linkId: "usb-abc", direction: "tx", line: "HELLO" }),
    ).toEqual({ type: "line", linkId: "usb-abc", direction: "tx", line: "HELLO" });
  });

  it("rejects a line message claiming direction rx from a client (server-only direction)", () => {
    expect(
      parseClientMessage({ type: "line", linkId: "usb-abc", direction: "rx", line: "HELLO" }),
    ).toBeUndefined();
  });

  it("accepts a well-formed flash-start message sourced from a release build", () => {
    expect(
      parseClientMessage({
        type: "flash-start",
        linkId: "usb-abc",
        source: { kind: "release", firmware: "relay" },
      }),
    ).toEqual({
      type: "flash-start",
      linkId: "usb-abc",
      source: { kind: "release", firmware: "relay" },
    });
  });

  it("accepts a well-formed flash-start message sourced from a local-hex upload", () => {
    expect(
      parseClientMessage({
        type: "flash-start",
        linkId: "usb-abc",
        source: { kind: "local-hex", uploadId: "upload-1", fileName: "custom.hex", sha256: "deadbeef" },
      }),
    ).toEqual({
      type: "flash-start",
      linkId: "usb-abc",
      source: { kind: "local-hex", uploadId: "upload-1", fileName: "custom.hex", sha256: "deadbeef" },
    });
  });

  it("accepts a well-formed send-command message with fields", () => {
    expect(
      parseClientMessage({
        type: "send-command",
        linkId: "usb-abc",
        verb: "SET",
        fields: ["k1", 42, { wireType: "flags", value: 216 }],
      }),
    ).toEqual({
      type: "send-command",
      linkId: "usb-abc",
      verb: "SET",
      fields: ["k1", 42, { wireType: "flags", value: 216 }],
    });
  });

  it("accepts a send-command message with fields omitted (bare-verb style, e.g. GET/STATUS)", () => {
    expect(parseClientMessage({ type: "send-command", linkId: "usb-abc", verb: "STATUS" })).toEqual({
      type: "send-command",
      linkId: "usb-abc",
      verb: "STATUS",
    });
  });

  it("accepts a send-command message with an explicit empty fields array", () => {
    expect(
      parseClientMessage({ type: "send-command", linkId: "usb-abc", verb: "GET", fields: [] }),
    ).toEqual({ type: "send-command", linkId: "usb-abc", verb: "GET", fields: [] });
  });

  describe("forget-device (replaces forget-known-robot)", () => {
    it("accepts a well-formed message", () => {
      expect(parseClientMessage({ type: "forget-device", deviceId: 1198504156 })).toEqual({
        type: "forget-device",
        deviceId: 1198504156,
      });
    });

    it("rejects a message with no deviceId", () => {
      expect(parseClientMessage({ type: "forget-device" })).toBeUndefined();
    });

    it("rejects a non-integer deviceId", () => {
      expect(parseClientMessage({ type: "forget-device", deviceId: "1198504156" })).toBeUndefined();
      expect(parseClientMessage({ type: "forget-device", deviceId: 1.5 })).toBeUndefined();
    });

    it("rejects the retired forget-known-robot message shape entirely", () => {
      expect(parseClientMessage({ type: "forget-known-robot", name: "zeguz" })).toBeUndefined();
    });
  });

  it("accepts a well-formed flash-local-begin message", () => {
    expect(
      parseClientMessage({
        type: "flash-local-begin",
        fileName: "custom.hex",
        byteLength: 12345,
        sha256: "deadbeef",
      }),
    ).toEqual({
      type: "flash-local-begin",
      fileName: "custom.hex",
      byteLength: 12345,
      sha256: "deadbeef",
    });
  });

  it.each([
    ["not an object", "nope"],
    ["null", null],
    ["missing type", {}],
    ["unknown type", { type: "flarp", linkId: "usb-abc" }],
    ["session-close with no linkId", { type: "session-close" }],
    ["line missing line field", { type: "line", linkId: "usb-abc", direction: "tx" }],
    ["line with non-string line field", { type: "line", linkId: "usb-abc", direction: "tx", line: 5 }],
    ["send-command with no linkId", { type: "send-command", verb: "GET" }],
    ["send-command with empty linkId", { type: "send-command", linkId: "", verb: "GET" }],
    ["send-command with non-string linkId", { type: "send-command", linkId: 5, verb: "GET" }],
    ["send-command with no verb", { type: "send-command", linkId: "usb-abc" }],
    ["send-command with empty verb", { type: "send-command", linkId: "usb-abc", verb: "" }],
    ["send-command with non-string verb", { type: "send-command", linkId: "usb-abc", verb: 5 }],
    [
      "send-command with a fields array containing a boolean",
      { type: "send-command", linkId: "usb-abc", verb: "SET", fields: [true] },
    ],
    [
      "send-command with a fields array containing an object missing wireType",
      { type: "send-command", linkId: "usb-abc", verb: "SET", fields: [{ value: 216 }] },
    ],
    [
      "send-command with a fields array containing a flags-shaped object with a non-numeric value",
      { type: "send-command", linkId: "usb-abc", verb: "SET", fields: [{ wireType: "flags", value: "216" }] },
    ],
    [
      "send-command with a non-array fields",
      { type: "send-command", linkId: "usb-abc", verb: "SET", fields: "nope" },
    ],
    ["flash-start with no linkId", { type: "flash-start", source: { kind: "release", firmware: "relay" } }],
    [
      "flash-start with empty linkId",
      { type: "flash-start", linkId: "", source: { kind: "release", firmware: "relay" } },
    ],
    [
      "flash-start with non-string linkId",
      { type: "flash-start", linkId: 5, source: { kind: "release", firmware: "relay" } },
    ],
    ["flash-start with no source", { type: "flash-start", linkId: "usb-abc" }],
    [
      "flash-start with an invalid firmware value",
      { type: "flash-start", linkId: "usb-abc", source: { kind: "release", firmware: "relayx" } },
    ],
    [
      "flash-start with an unknown source kind",
      { type: "flash-start", linkId: "usb-abc", source: { kind: "carrier-pigeon" } },
    ],
    [
      "flash-start with a local-hex source missing sha256",
      {
        type: "flash-start",
        linkId: "usb-abc",
        source: { kind: "local-hex", uploadId: "upload-1", fileName: "custom.hex" },
      },
    ],
    ["flash-local-begin missing fileName", { type: "flash-local-begin", byteLength: 10, sha256: "deadbeef" }],
    [
      "flash-local-begin with a non-positive byteLength",
      { type: "flash-local-begin", fileName: "custom.hex", byteLength: 0, sha256: "deadbeef" },
    ],
    [
      "flash-local-begin with a non-numeric byteLength",
      { type: "flash-local-begin", fileName: "custom.hex", byteLength: "10", sha256: "deadbeef" },
    ],
    ["flash-local-begin missing sha256", { type: "flash-local-begin", fileName: "custom.hex", byteLength: 10 }],
  ])("rejects: %s", (_label, value) => {
    expect(parseClientMessage(value)).toBeUndefined();
  });
});

describe("TelemetryMessage (linkId-keyed, sprint 15 reshape)", () => {
  it("is a distinct type discriminator from line/snapshot, carrying either a header or a frame", () => {
    // Type-level fixture: this compiles only if both shapes below are
    // legal TelemetryMessage/ServerMessage values.
    const header: TelemetryMessage = {
      type: "telemetry",
      linkId: "usb-SERIAL-A",
      header: ["seq", "now", "flags", "posl", "posr", "vell", "velr"],
    };
    const frame: TelemetryMessage = {
      type: "telemetry",
      linkId: "usb-SERIAL-A",
      frame: { seq: "1", now: "2", flags: "3", posl: "4", posr: "5", vell: "6", velr: "7" },
      seq: 12,
    };
    const asServerMessages: ServerMessage[] = [header, frame];
    expect(asServerMessages.every((m) => m.type === "telemetry")).toBe(true);
    expect(header.frame).toBeUndefined();
    expect(frame.header).toBeUndefined();
  });
});
