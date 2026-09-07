import { describe, expect, it } from "vitest";
import { parseClientMessage } from "./wsMessages.js";

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
  ])("rejects: %s", (_label, value) => {
    expect(parseClientMessage(value)).toBeUndefined();
  });
});
