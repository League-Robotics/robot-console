/**
 * lineClass.test.ts — `classifyLine`'s classification cases, moved here
 * from `DeviceConsole.test.tsx`'s own former inline cases (ticket
 * 017-007): comment/debug/error/ack/data, in that priority order.
 */
import { describe, expect, it } from "vitest";
import { classifyLine } from "./lineClass";

describe("classifyLine", () => {
  it("classifies a # comment line", () => {
    expect(classifyLine("# a note")).toBe("comment");
    expect(classifyLine("  # indented note")).toBe("comment");
  });

  it("classifies a DBG: line as debug", () => {
    expect(classifyLine("DBG: motor stalled")).toBe("debug");
  });

  it("classifies err/nack lines as error, case-insensitively", () => {
    expect(classifyLine("err 1 #7")).toBe("error");
    expect(classifyLine("ERR 1 #7")).toBe("error");
    expect(classifyLine("nack #3")).toBe("error");
  });

  it("classifies an ack line as ack, case-insensitively", () => {
    expect(classifyLine("ack #3")).toBe("ack");
    expect(classifyLine("ACK #3")).toBe("ack");
  });

  it("classifies anything else as plain data", () => {
    expect(classifyLine("status ready=1 active=0")).toBe("data");
    expect(classifyLine("get wheel_diameter 65.2")).toBe("data");
  });

  it("prioritizes comment/debug/error/ack over a coincidental data match", () => {
    // A line starting with "#" is a comment even if it later contains
    // "err"/"ack" text -- the leading-token check runs first.
    expect(classifyLine("# ack this looks weird")).toBe("comment");
  });
});
