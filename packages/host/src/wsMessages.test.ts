import { describe, expect, it } from "vitest";
import { parseClientMessage } from "./wsMessages.js";
import type { EndpointListEntry, ServerMessage, TelemetryMessage } from "./wsMessages.js";

describe("parseClientMessage", () => {
  it("accepts a well-formed session-open message", () => {
    expect(parseClientMessage({ type: "session-open", endpointId: "usb-abc" })).toEqual({
      type: "session-open",
      endpointId: "usb-abc",
    });
  });

  it("accepts a session-open message carrying the reserved robotName field", () => {
    expect(
      parseClientMessage({ type: "session-open", endpointId: "usb-abc", robotName: "zeguz" }),
    ).toEqual({ type: "session-open", endpointId: "usb-abc", robotName: "zeguz" });
  });

  it("rejects a session-open message with a non-string robotName", () => {
    expect(
      parseClientMessage({ type: "session-open", endpointId: "usb-abc", robotName: 5 }),
    ).toBeUndefined();
  });

  it("accepts a session-open message with autoRobot: true and no robotName (sprint 8 ticket 005 default failover)", () => {
    expect(
      parseClientMessage({ type: "session-open", endpointId: "usb-abc", autoRobot: true }),
    ).toEqual({ type: "session-open", endpointId: "usb-abc", autoRobot: true });
  });

  it("rejects a session-open message with autoRobot set to anything other than true", () => {
    expect(
      parseClientMessage({ type: "session-open", endpointId: "usb-abc", autoRobot: false }),
    ).toBeUndefined();
    expect(
      parseClientMessage({ type: "session-open", endpointId: "usb-abc", autoRobot: "true" }),
    ).toBeUndefined();
  });

  it("accepts a well-formed session-close message", () => {
    expect(parseClientMessage({ type: "session-close", endpointId: "usb-abc" })).toEqual({
      type: "session-close",
      endpointId: "usb-abc",
    });
  });

  it("accepts a well-formed outbound line message", () => {
    expect(
      parseClientMessage({ type: "line", endpointId: "usb-abc", direction: "tx", line: "HELLO" }),
    ).toEqual({ type: "line", endpointId: "usb-abc", direction: "tx", line: "HELLO" });
  });

  it("rejects a line message claiming direction rx from a client (server-only direction)", () => {
    expect(
      parseClientMessage({ type: "line", endpointId: "usb-abc", direction: "rx", line: "HELLO" }),
    ).toBeUndefined();
  });

  it("accepts a well-formed flash-start message sourced from a release build", () => {
    expect(
      parseClientMessage({
        type: "flash-start",
        endpointId: "usb-abc",
        source: { kind: "release", firmware: "relay" },
      }),
    ).toEqual({
      type: "flash-start",
      endpointId: "usb-abc",
      source: { kind: "release", firmware: "relay" },
    });
  });

  it("accepts a well-formed flash-start message sourced from a local-hex upload", () => {
    expect(
      parseClientMessage({
        type: "flash-start",
        endpointId: "usb-abc",
        source: { kind: "local-hex", uploadId: "upload-1", fileName: "custom.hex", sha256: "deadbeef" },
      }),
    ).toEqual({
      type: "flash-start",
      endpointId: "usb-abc",
      source: { kind: "local-hex", uploadId: "upload-1", fileName: "custom.hex", sha256: "deadbeef" },
    });
  });

  it("accepts a well-formed send-command message with fields", () => {
    expect(
      parseClientMessage({
        type: "send-command",
        endpointId: "usb-abc",
        verb: "SET",
        fields: ["k1", 42, { wireType: "flags", value: 216 }],
      }),
    ).toEqual({
      type: "send-command",
      endpointId: "usb-abc",
      verb: "SET",
      fields: ["k1", 42, { wireType: "flags", value: 216 }],
    });
  });

  it("accepts a send-command message with fields omitted (bare-verb style, e.g. GET/STATUS)", () => {
    expect(parseClientMessage({ type: "send-command", endpointId: "usb-abc", verb: "STATUS" })).toEqual({
      type: "send-command",
      endpointId: "usb-abc",
      verb: "STATUS",
    });
  });

  it("accepts a send-command message with an explicit empty fields array", () => {
    expect(
      parseClientMessage({ type: "send-command", endpointId: "usb-abc", verb: "GET", fields: [] }),
    ).toEqual({ type: "send-command", endpointId: "usb-abc", verb: "GET", fields: [] });
  });

  it("accepts a well-formed forget-known-robot message", () => {
    expect(parseClientMessage({ type: "forget-known-robot", name: "zeguz" })).toEqual({
      type: "forget-known-robot",
      name: "zeguz",
    });
  });

  it("rejects a forget-known-robot message with no name", () => {
    expect(parseClientMessage({ type: "forget-known-robot" })).toBeUndefined();
  });

  it("rejects a forget-known-robot message with an empty name", () => {
    expect(parseClientMessage({ type: "forget-known-robot", name: "" })).toBeUndefined();
  });

  it("rejects a forget-known-robot message with a non-string name", () => {
    expect(parseClientMessage({ type: "forget-known-robot", name: 5 })).toBeUndefined();
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
    ["unknown type", { type: "flarp", endpointId: "usb-abc" }],
    ["session-open with no endpointId", { type: "session-open" }],
    ["session-open with empty endpointId", { type: "session-open", endpointId: "" }],
    ["session-open with non-string endpointId", { type: "session-open", endpointId: 5 }],
    ["session-close with no endpointId", { type: "session-close" }],
    ["line missing line field", { type: "line", endpointId: "usb-abc", direction: "tx" }],
    ["line with non-string line field", { type: "line", endpointId: "usb-abc", direction: "tx", line: 5 }],
    ["send-command with no endpointId", { type: "send-command", verb: "GET" }],
    ["send-command with empty endpointId", { type: "send-command", endpointId: "", verb: "GET" }],
    ["send-command with non-string endpointId", { type: "send-command", endpointId: 5, verb: "GET" }],
    ["send-command with no verb", { type: "send-command", endpointId: "usb-abc" }],
    ["send-command with empty verb", { type: "send-command", endpointId: "usb-abc", verb: "" }],
    ["send-command with non-string verb", { type: "send-command", endpointId: "usb-abc", verb: 5 }],
    [
      "send-command with a fields array containing a boolean",
      { type: "send-command", endpointId: "usb-abc", verb: "SET", fields: [true] },
    ],
    [
      "send-command with a fields array containing an object missing wireType",
      { type: "send-command", endpointId: "usb-abc", verb: "SET", fields: [{ value: 216 }] },
    ],
    [
      "send-command with a fields array containing a flags-shaped object with a non-numeric value",
      { type: "send-command", endpointId: "usb-abc", verb: "SET", fields: [{ wireType: "flags", value: "216" }] },
    ],
    [
      "send-command with a non-array fields",
      { type: "send-command", endpointId: "usb-abc", verb: "SET", fields: "nope" },
    ],
    ["flash-start with no endpointId", { type: "flash-start", source: { kind: "release", firmware: "relay" } }],
    [
      "flash-start with empty endpointId",
      { type: "flash-start", endpointId: "", source: { kind: "release", firmware: "relay" } },
    ],
    [
      "flash-start with non-string endpointId",
      { type: "flash-start", endpointId: 5, source: { kind: "release", firmware: "relay" } },
    ],
    ["flash-start with no source", { type: "flash-start", endpointId: "usb-abc" }],
    [
      "flash-start with an invalid firmware value",
      { type: "flash-start", endpointId: "usb-abc", source: { kind: "release", firmware: "relayx" } },
    ],
    [
      "flash-start with an unknown source kind",
      { type: "flash-start", endpointId: "usb-abc", source: { kind: "carrier-pigeon" } },
    ],
    [
      "flash-start with a local-hex source missing sha256",
      {
        type: "flash-start",
        endpointId: "usb-abc",
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

describe("EndpointListEntry", () => {
  it("still round-trips as a valid EndpointListEntry when every optional field is absent", () => {
    // Type-level fixture: this compiles only if nameError/sessionError/
    // flashStatus/usb are all optional, proving the reshaped entry is
    // additive over the fields that were already optional pre-sprint-4.
    const entry: EndpointListEntry = {
      endpointId: "usb-SERIAL-A",
      transport: "usb",
      resourceKey: "usb-SERIAL-A",
      classification: { type: "robot", role: "NEZHA2", commonName: "robot", dialect: "space", evidence: "role" },
      role: "NEZHA2",
      name: "zeguz",
      sessionOpen: true,
    };
    expect(entry.flashStatus).toBeUndefined();
    expect(entry.usb).toBeUndefined();
    expect(entry.nameError).toBeUndefined();
    expect(entry.sessionError).toBeUndefined();
    expect(entry.sequencing).toBeUndefined();
  });

  it("carries a zero-state sequencing field distinguishable from absent", () => {
    // A client can tell "session just opened, nothing sent or confirmed
    // yet" (sequencing present with zeroed counters) apart from "no
    // session open" or "talking to an old server" (sequencing absent
    // entirely) -- see wsMessages.ts's "Sprint 6 addition" doc comment.
    const entry: EndpointListEntry = {
      endpointId: "usb-SERIAL-A",
      transport: "usb",
      resourceKey: "usb-SERIAL-A",
      classification: { type: "robot", role: "NEZHA2", commonName: "robot", dialect: "space", evidence: "role" },
      role: "NEZHA2",
      name: "zeguz",
      sessionOpen: true,
      sequencing: { seq: 0, pendingCount: 0, lastDone: 0, lastDoneReason: "none" },
    };
    expect(entry.sequencing).toEqual({ seq: 0, pendingCount: 0, lastDone: 0, lastDoneReason: "none" });
  });
});

describe("TelemetryMessage (sprint 009 ticket 002)", () => {
  it("is a distinct type discriminator from line/endpoints, carrying either a header or a frame", () => {
    // Type-level fixture: this compiles only if both shapes below are
    // legal TelemetryMessage/ServerMessage values -- see wsMessages.ts's
    // own doc comment for why header/frame are mutually exclusive on
    // the wire (deviceRegistry.ts never sends both on one message).
    const header: TelemetryMessage = {
      type: "telemetry",
      endpointId: "usb-SERIAL-A",
      header: ["seq", "now", "flags", "posl", "posr", "vell", "velr"],
    };
    const frame: TelemetryMessage = {
      type: "telemetry",
      endpointId: "usb-SERIAL-A",
      frame: { seq: "1", now: "2", flags: "3", posl: "4", posr: "5", vell: "6", velr: "7" },
    };
    const asServerMessages: ServerMessage[] = [header, frame];
    expect(asServerMessages.every((m) => m.type === "telemetry")).toBe(true);
    expect(header.frame).toBeUndefined();
    expect(frame.header).toBeUndefined();
  });
});
