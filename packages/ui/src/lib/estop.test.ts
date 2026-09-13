/**
 * estop.test.ts — `clearEstop` sends exactly `SET estop_clear 1` then
 * `STATUS`, in that order, on the given link -- the one shared
 * definition `StatusPanel.tsx` and `DriveControls.tsx` both call into
 * (ticket 017-007).
 */
import { describe, expect, it, vi } from "vitest";
import { clearEstop } from "./estop";

describe("clearEstop", () => {
  it("sends SET estop_clear 1 followed by a bare STATUS, in order", () => {
    const sendCommand = vi.fn();
    clearEstop(sendCommand, "usb-ROBOT-A");
    expect(sendCommand.mock.calls).toEqual([
      ["usb-ROBOT-A", "SET", ["estop_clear", "1"]],
      ["usb-ROBOT-A", "STATUS"],
    ]);
  });

  it("addresses whatever linkId it's given", () => {
    const sendCommand = vi.fn();
    clearEstop(sendCommand, "radio-x-via-usb-relay-1");
    expect(sendCommand).toHaveBeenCalledWith("radio-x-via-usb-relay-1", "SET", ["estop_clear", "1"]);
    expect(sendCommand).toHaveBeenCalledWith("radio-x-via-usb-relay-1", "STATUS");
  });
});
