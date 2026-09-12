// @vitest-environment jsdom
/**
 * useHeldDrive.test.ts — focused unit tests for the shared held-drive
 * engine (ticket 017-007), exercised directly against a tiny harness
 * component rather than through `DriveControls`/`DriveTab` -- those two
 * keep their own component tests for the button/keyboard/gamepad
 * integration; this file is the one place the resend/lease/cleanup
 * timing itself is pinned, so that logic is asserted exactly once.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useHeldDrive, type HeldDriveEngine, type WheelTarget } from "./useHeldDrive";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function Harness({
  sendCommand,
  linkId,
  linkOpen,
  onEngine,
}: {
  sendCommand: (linkId: string, verb: string, fields?: unknown[]) => void;
  linkId: string;
  linkOpen: boolean;
  onEngine: (engine: HeldDriveEngine) => void;
}) {
  const engine = useHeldDrive(sendCommand, linkId, linkOpen);
  onEngine(engine);
  return null;
}

function mountHarness(linkId: string, linkOpen: boolean): { sendCommand: ReturnType<typeof vi.fn>; engine: HeldDriveEngine; setLinkOpen: (open: boolean) => void; unmount: () => void } {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const sendCommand = vi.fn();
  let engine!: HeldDriveEngine;

  function render(open: boolean): void {
    act(() => {
      root!.render(<Harness sendCommand={sendCommand} linkId={linkId} linkOpen={open} onEngine={(e) => (engine = e)} />);
    });
  }

  render(linkOpen);

  return {
    sendCommand,
    get engine() {
      return engine;
    },
    setLinkOpen: (open: boolean) => render(open),
    unmount: () => {
      act(() => {
        root!.unmount();
      });
    },
  };
}

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
  vi.useRealTimers();
});

const LINK_ID = "usb-ROBOT-A";
const FORWARD: WheelTarget = [150, 150];

describe("useHeldDrive", () => {
  it("sends WHEELS_V immediately when a target is first set", () => {
    const { sendCommand, engine } = mountHarness(LINK_ID, true);
    act(() => {
      engine.setTarget(FORWARD);
    });
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith(LINK_ID, "WHEELS_V", [150, 150, 400]);
  });

  it("resends every 150ms while held, comfortably inside the 400ms lease", () => {
    vi.useFakeTimers();
    const { sendCommand, engine } = mountHarness(LINK_ID, true);
    act(() => {
      engine.setTarget(FORWARD);
    });
    expect(sendCommand).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(sendCommand).toHaveBeenCalledTimes(2);

    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(sendCommand).toHaveBeenCalledTimes(3);
    expect(sendCommand.mock.calls.every((call) => call[1] === "WHEELS_V")).toBe(true);
  });

  it("sends exactly one STOP (no fields) when the target clears, and stops resending", () => {
    vi.useFakeTimers();
    const { sendCommand, engine } = mountHarness(LINK_ID, true);
    act(() => {
      engine.setTarget(FORWARD);
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(sendCommand).toHaveBeenCalledTimes(2);

    act(() => {
      engine.setTarget(null);
    });
    expect(sendCommand).toHaveBeenLastCalledWith(LINK_ID, "STOP");

    const countAfterStop = sendCommand.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(sendCommand.mock.calls.length).toBe(countAfterStop);
  });

  it("clearing an already-clear target sends nothing (no redundant STOP)", () => {
    const { sendCommand, engine } = mountHarness(LINK_ID, true);
    act(() => {
      engine.setTarget(null);
    });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("a redundant setTarget call while already driving does not send immediately -- the running resend picks up the new value at its next tick", () => {
    vi.useFakeTimers();
    const { sendCommand, engine } = mountHarness(LINK_ID, true);
    act(() => {
      engine.setTarget(FORWARD);
    });
    expect(sendCommand).toHaveBeenCalledTimes(1);

    act(() => {
      engine.setTarget([75, 75]);
    });
    // No immediate send for the updated target.
    expect(sendCommand).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(sendCommand).toHaveBeenCalledTimes(2);
    expect(sendCommand).toHaveBeenLastCalledWith(LINK_ID, "WHEELS_V", [75, 75, 400]);
  });

  it("does not send WHEELS_V at all when the link is not open", () => {
    const { sendCommand, engine } = mountHarness(LINK_ID, false);
    act(() => {
      engine.setTarget(FORWARD);
    });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("sends STOP and tears down the timer when the link closes mid-hold", () => {
    vi.useFakeTimers();
    const { sendCommand, engine, setLinkOpen } = mountHarness(LINK_ID, true);
    act(() => {
      engine.setTarget(FORWARD);
    });
    expect(sendCommand).toHaveBeenCalledTimes(1);

    setLinkOpen(false);
    expect(sendCommand).toHaveBeenLastCalledWith(LINK_ID, "STOP");

    const countAfterClose = sendCommand.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(sendCommand.mock.calls.length).toBe(countAfterClose);
  });

  it("sends STOP on unmount while a target is held", () => {
    const { sendCommand, engine, unmount } = mountHarness(LINK_ID, true);
    act(() => {
      engine.setTarget(FORWARD);
    });
    unmount();
    expect(sendCommand).toHaveBeenLastCalledWith(LINK_ID, "STOP");
  });

  it("sends nothing on unmount when nothing was held", () => {
    const { sendCommand, unmount } = mountHarness(LINK_ID, true);
    unmount();
    expect(sendCommand).not.toHaveBeenCalled();
  });
});
