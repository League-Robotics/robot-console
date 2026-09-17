import { describe, expect, it } from "vitest";
import { LineReassembler } from "./lineReassembler.js";

describe("LineReassembler", () => {
  it("returns no lines until a newline arrives", () => {
    const r = new LineReassembler();
    expect(r.push("device NEZHA2 robot vevov")).toEqual([]);
  });

  it("returns a complete line once its newline arrives, across two push calls", () => {
    const r = new LineReassembler();
    expect(r.push("device NEZHA2 robot vevov")).toEqual([]);
    expect(r.push(" 1198504156\n")).toEqual(["device NEZHA2 robot vevov 1198504156"]);
  });

  it("strips a trailing \\r (CRLF wire framing)", () => {
    const r = new LineReassembler();
    expect(r.push("# echo: OFF\r\n")).toEqual(["# echo: OFF"]);
  });

  it("splits multiple lines delivered in one chunk", () => {
    const r = new LineReassembler();
    expect(r.push("# echo: OFF\n# mode: RAW250\n")).toEqual(["# echo: OFF", "# mode: RAW250"]);
  });

  it("handles a Buffer chunk the same as a string one", () => {
    const r = new LineReassembler();
    expect(r.push(Buffer.from("HELLO\n", "utf8"))).toEqual(["HELLO"]);
  });

  it("preserves a leading relay pass-through '< ' prefix verbatim", () => {
    const r = new LineReassembler();
    expect(r.push("< device NEZHA2 robot vevov 1198504156\n")).toEqual([
      "< device NEZHA2 robot vevov 1198504156",
    ]);
  });

  it("discards a partial line that grows past the buffer cap without ever seeing a newline", () => {
    const r = new LineReassembler(16);
    expect(r.push("no newline here, this keeps growing and growing")).toEqual([]);
    // Buffer was reset by the overflow guard -- a newline arriving now
    // only completes whatever came after the discard, not the original
    // oversized fragment.
    expect(r.push("short\n")).toEqual(["short"]);
  });
});
