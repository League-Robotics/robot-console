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

  it("does NOT strip a leading '< ' prefix -- that moved to @robot-console/protocol's decodeLine (ticket 014-004)", () => {
    const r = new LineReassembler();
    expect(r.push("< pong\n")).toEqual(["< pong"]);
  });

  it("strips a trailing \\r even when the line still carries its '< ' prefix", () => {
    const r = new LineReassembler();
    expect(r.push("< ack 1 0 none\r\n")).toEqual(["< ack 1 0 none"]);
  });

  it("leaves an embedded (non-leading) '< ' untouched, same as before", () => {
    const r = new LineReassembler();
    expect(r.push("ret 1 < 2\n")).toEqual(["ret 1 < 2"]);
  });

  // Max-buffer guard (ticket 014-005 / review 02-host-transport.md S6:
  // "grows unbounded without \n"). A caller that never sets
  // `maxBufferChars` keeps the previous, effectively-unbounded-for-any-
  // real-line behavior via the generous default -- these tests set a
  // tiny cap to exercise the guard deterministically.
  describe("max-buffer guard", () => {
    it("discards a partial line once it exceeds maxBufferChars, instead of growing forever", () => {
      const overflowed: string[] = [];
      const r = new LineReassembler({ maxBufferChars: 8, onOverflow: (discarded) => overflowed.push(discarded) });

      expect(r.push("x".repeat(20))).toEqual([]);
      expect(overflowed).toEqual(["x".repeat(20)]);

      // The buffer was reset -- a newline arriving next starts a fresh
      // line, it does not complete the discarded one.
      expect(r.push("ok\n")).toEqual(["ok"]);
    });

    it("does not trip the guard for a complete line under the cap, even split across pushes", () => {
      const overflowed: string[] = [];
      const r = new LineReassembler({ maxBufferChars: 8, onOverflow: (discarded) => overflowed.push(discarded) });

      expect(r.push("ack 1")).toEqual([]);
      expect(r.push(" 0 none\n")).toEqual(["ack 1 0 none"]);
      expect(overflowed).toEqual([]);
    });

    it("defaults to a generous cap when maxBufferChars is not given -- an ordinary line is unaffected", () => {
      const r = new LineReassembler();
      expect(r.push("pong\n")).toEqual(["pong"]);
    });
  });
});
