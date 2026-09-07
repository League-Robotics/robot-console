import { describe, expect, it } from "vitest";
import { LineReassembler } from "./lineStream.js";

// Moved verbatim out of UsbSerialLink.test.ts (sprint 4 ticket 002) --
// no behavior change, import path only.

describe("LineReassembler", () => {
  it("returns nothing until a newline arrives, then the complete line", () => {
    const r = new LineReassembler();
    expect(r.push("ack 1 0 n")).toEqual([]);
    expect(r.push("one\n")).toEqual(["ack 1 0 none"]);
  });

  it("splits a single chunk carrying multiple lines", () => {
    const r = new LineReassembler();
    expect(r.push("pong\nack 1 0 none\n")).toEqual(["pong", "ack 1 0 none"]);
  });

  it("strips a trailing \\r", () => {
    const r = new LineReassembler();
    expect(r.push("pong\r\n")).toEqual(["pong"]);
  });

  it("strips a leading '< ' prefix unconditionally", () => {
    const r = new LineReassembler();
    expect(r.push("< pong\n")).toEqual(["pong"]);
  });

  it("strips both '< ' and a trailing \\r on the same line", () => {
    const r = new LineReassembler();
    expect(r.push("< ack 1 0 none\r\n")).toEqual(["ack 1 0 none"]);
  });

  it("does not strip '< ' if it is not a leading prefix", () => {
    const r = new LineReassembler();
    expect(r.push("ret 1 < 2\n")).toEqual(["ret 1 < 2"]);
  });
});
