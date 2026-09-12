// @vitest-environment jsdom
/**
 * DriveTab.test.tsx — cursor-key and gamepad driving (OOP 2026-09-10;
 * migrated to the `Snapshot` contract, sprint 015 ticket 009). Both
 * must speak DriveControls' held-button dialect exactly: `WHEELS_V left
 * right 400` on press, re-sent every 150 ms, one `STOP` on release.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { DriveTab, gamepadTarget, keyboardTarget, mixWheels } from "./DriveTab";
import { WsProvider } from "../ws/WsProvider";
import { FakeSocket } from "../testing/FakeSocket";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(node: ReactElement): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

beforeEach(() => {
  vi.useFakeTimers();
});

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
  delete (navigator as unknown as { getGamepads?: unknown }).getGamepads;
});

const LINK_ID = "usb-ROBOT-A";

function openLink(overrides: Partial<SnapshotLink> = {}): SnapshotLink {
  return {
    id: LINK_ID,
    transport: "usb",
    label: "USB · /dev/cu.usbmodemC",
    state: "connected",
    reason: null,
    since: 0,
    lastSeen: 0,
    nextRetryAt: null,
    capabilities: { open: false, close: true, flash: true, provisionWifi: true },
    session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null },
    ...overrides,
  };
}

function closedLink(overrides: Partial<Omit<SnapshotLink, "session">> = {}): SnapshotLink {
  return {
    id: LINK_ID,
    transport: "usb",
    label: "USB · /dev/cu.usbmodemC",
    state: "connectable",
    reason: null,
    since: 0,
    lastSeen: 0,
    nextRetryAt: null,
    capabilities: { open: true, close: false, flash: true, provisionWifi: false },
    ...overrides,
  };
}

function mountTab(link: SnapshotLink = openLink()): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <DriveTab link={link} />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  socket!.sent.length = 0;
  return { el, socket: socket! };
}

function sent(socket: FakeSocket): Array<{ verb: string; fields?: number[] }> {
  return socket.sent.map((raw) => JSON.parse(raw) as { verb: string; fields?: number[] });
}

function key(type: "keydown" | "keyup", code: string, target: EventTarget = window, repeat = false): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent(type, { code, repeat, bubbles: true }));
  });
}

describe("wheel mixing", () => {
  it("keyboardTarget: up drives, left/right turn in place, diagonals arc, nothing held is null", () => {
    expect(keyboardTarget(new Set())).toBeNull();
    expect(keyboardTarget(new Set(["ArrowUp"]))).toEqual([150, 150]);
    expect(keyboardTarget(new Set(["ArrowDown"]))).toEqual([-150, -150]);
    expect(keyboardTarget(new Set(["ArrowLeft"]))).toEqual([-150, 150]);
    expect(keyboardTarget(new Set(["KeyD"]))).toEqual([150, -150]);
    expect(keyboardTarget(new Set(["ArrowUp", "ArrowRight"]))).toEqual([150, 0]);
    expect(keyboardTarget(new Set(["ArrowUp", "ArrowDown"]))).toBeNull();
  });

  it("gamepadTarget: dead zone, proportional speed, browser y-up-is-negative convention", () => {
    expect(gamepadTarget(0.05, -0.05)).toBeNull();
    expect(gamepadTarget(0, -1)).toEqual([150, 150]);
    expect(gamepadTarget(0, -0.5)).toEqual([75, 75]);
    expect(gamepadTarget(1, 0)).toEqual([150, -150]);
    expect(gamepadTarget(0.4, -1)).toEqual([150, 90]);
    expect(mixWheels(300, 0)).toEqual([150, 150]);
  });
});

describe("DriveTab keyboard", () => {
  it("ArrowUp sends WHEELS_V immediately, re-sends while held, and STOPs on release", () => {
    const { socket } = mountTab();
    key("keydown", "ArrowUp");
    expect(sent(socket)).toEqual([{ type: "send-command", linkId: LINK_ID, verb: "WHEELS_V", fields: [150, 150, 400] }]);
    act(() => {
      vi.advanceTimersByTime(320);
    });
    expect(sent(socket).filter((m) => m.verb === "WHEELS_V")).toHaveLength(3);
    key("keydown", "ArrowUp", window, true); // auto-repeat: ignored
    expect(sent(socket).filter((m) => m.verb === "WHEELS_V")).toHaveLength(3);
    key("keyup", "ArrowUp");
    expect(sent(socket).at(-1)).toEqual({ type: "send-command", linkId: LINK_ID, verb: "STOP" });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(sent(socket).filter((m) => m.verb === "WHEELS_V")).toHaveLength(3);
  });

  it("adding ArrowRight to a held ArrowUp changes the target to an arc; space stops everything", () => {
    const { socket } = mountTab();
    key("keydown", "ArrowUp");
    key("keydown", "ArrowRight");
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(sent(socket).at(-1)).toEqual({ type: "send-command", linkId: LINK_ID, verb: "WHEELS_V", fields: [150, 0, 400] });
    key("keydown", "Space");
    const tail = sent(socket).slice(-2);
    expect(tail[0]).toEqual({ type: "send-command", linkId: LINK_ID, verb: "STOP" });
    expect(tail[1]).toEqual({ type: "send-command", linkId: LINK_ID, verb: "STOP", fields: ["now"] });
  });

  it("ignores keys typed into a text field and sends nothing with no link open", () => {
    const { el, socket } = mountTab();
    const input = document.createElement("input");
    el.appendChild(input);
    key("keydown", "ArrowUp", input);
    expect(sent(socket)).toEqual([]);
    input.remove();

    act(() => {
      root!.unmount();
    });
    root = null;
    container?.remove();
    container = null;
    const closed = mountTab(closedLink());
    key("keydown", "ArrowUp");
    expect(sent(closed.socket)).toEqual([]);
  });

  it("shows which keys are held", () => {
    const { el } = mountTab();
    key("keydown", "ArrowUp");
    expect(el.querySelector('[data-testid="drive-tab-keyboard"]')?.textContent).toContain("Holding Up");
  });
});

describe("DriveTab gamepad", () => {
  function stubGamepad(axes: number[] | null): void {
    const pads =
      axes === null
        ? []
        : [{ id: "Test Pad (Vendor: 0000 Product: 0000)", index: 0, connected: true, axes, buttons: [], mapping: "standard", timestamp: 0 }];
    (navigator as unknown as { getGamepads: () => Gamepad[] }).getGamepads = () => pads as unknown as Gamepad[];
  }

  it("reports the pad, drives proportionally from the left stick, and STOPs when the stick centres", () => {
    stubGamepad([0, 0]);
    const { el, socket } = mountTab();
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(el.querySelector('[data-testid="drive-tab-gamepad"]')?.textContent).toContain("Test Pad");
    expect(sent(socket)).toEqual([]);

    stubGamepad([0.4, -1]);
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(sent(socket)[0]).toEqual({ type: "send-command", linkId: LINK_ID, verb: "WHEELS_V", fields: [150, 90, 400] });
    expect(el.querySelector('[data-testid="drive-tab-gamepad"]')?.textContent).toContain("Wheels 150 / 90 mm/s");

    stubGamepad([0, 0]);
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(sent(socket).at(-1)).toEqual({ type: "send-command", linkId: LINK_ID, verb: "STOP" });
  });

  it("never sends more often than the resend cadence while the stick keeps moving; the latest position rides the next tick", () => {
    stubGamepad([0, 0]);
    const { socket } = mountTab();
    stubGamepad([0, -0.5]);
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(sent(socket)).toEqual([{ type: "send-command", linkId: LINK_ID, verb: "WHEELS_V", fields: [75, 75, 400] }]);
    stubGamepad([0, -0.7]);
    act(() => {
      vi.advanceTimersByTime(50);
    });
    stubGamepad([0, -1]);
    act(() => {
      vi.advanceTimersByTime(30);
    });
    // 140 ms in (90 ms after the first send): still only the first send.
    expect(sent(socket)).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(sent(socket)).toHaveLength(2);
    expect(sent(socket)[1]).toEqual({ type: "send-command", linkId: LINK_ID, verb: "WHEELS_V", fields: [150, 150, 400] });
  });

  it("says none detected without a pad", () => {
    stubGamepad(null);
    const { el } = mountTab();
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(el.querySelector('[data-testid="drive-tab-gamepad"]')?.textContent).toContain("none detected");
  });
});
