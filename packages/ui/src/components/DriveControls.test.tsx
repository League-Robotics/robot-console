// @vitest-environment jsdom
/**
 * DriveControls.test.tsx — component tests (ticket 005 / SUC-001).
 *
 * Proves the hold-resend-release lease discipline this module's own
 * doc comment describes: pressing sends `WHEELS_V` immediately; holding
 * resends it before the lease would expire; releasing sends `STOP` and
 * stops resending. These tests exercise the command *plumbing* only
 * (a fake `WsProvider` socket) — they prove no claim about a real robot
 * moving, which is hardware-deferred per this ticket's Acceptance
 * Criteria.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { DriveControls } from "./DriveControls";
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

function baseDevice(overrides: Partial<EndpointListEntry> = {}): EndpointListEntry {
  return {
    endpointId: "usb-ROBOT-A",
    transport: "usb",
    resourceKey: "usb-ROBOT-A",
    classification: { type: "robot", role: "NEZHA2", commonName: "robot", dialect: "space", evidence: "role" },
    name: "zavaz",
    role: "NEZHA2",
    sessionOpen: true,
    usb: { serialNumber: "ROBOT-A-FULL", displaySerial: "0004", port: "/dev/cu.usbmodemC" },
    ...overrides,
  };
}

function mountControls(device: EndpointListEntry): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <DriveControls device={device} />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket! };
}

/** Like `mountControls`, but keeps `WsProvider` itself mounted (same
 * `url`/`socketFactory` reference across renders, so its own connect
 * effect never re-runs) and lets the caller unmount just `DriveControls`
 * -- mirroring the real app, where `WsProvider` lives above the router
 * and never unmounts when a page component does (e.g. navigating away
 * from `RobotPage`). Unmounting the *whole* tree in one `root.unmount()`
 * (as the other tests in this file do at the very end, via `afterEach`)
 * tears down `WsProvider`'s own socket in the same pass, and the order
 * between a child's cleanup and its parent's is not something this
 * component should need to depend on. */
function mountControlsRemovable(
  device: EndpointListEntry,
): { el: HTMLDivElement; socket: FakeSocket; unmountDriveControls: () => Promise<void> } {
  let socket: FakeSocket | null = null;
  const socketFactory = () => (socket = new FakeSocket());
  const url = "ws://test/";
  const el = mount(
    <WsProvider url={url} socketFactory={socketFactory}>
      <DriveControls device={device} />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return {
    el,
    socket: socket!,
    unmountDriveControls: async () => {
      await act(async () => {
        root!.render(
          <WsProvider url={url} socketFactory={socketFactory}>
            {null}
          </WsProvider>,
        );
      });
    },
  };
}

function sentMessages(socket: FakeSocket): unknown[] {
  return socket.sent.map((s) => JSON.parse(s));
}

describe("DriveControls", () => {
  it("sends WHEELS_V immediately on press", () => {
    const { el, socket } = mountControls(baseDevice());
    const forward = el.querySelector<HTMLButtonElement>('[data-testid="drive-forward"]')!;

    act(() => {
      forward.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(sentMessages(socket)).toEqual([
      { type: "send-command", endpointId: "usb-ROBOT-A", verb: "WHEELS_V", fields: [150, 150, 400] },
    ]);
  });

  it("resends WHEELS_V periodically while held, before the lease expires", () => {
    vi.useFakeTimers();
    const { el, socket } = mountControls(baseDevice());
    const forward = el.querySelector<HTMLButtonElement>('[data-testid="drive-forward"]')!;

    act(() => {
      forward.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(socket.sent).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(socket.sent).toHaveLength(2);

    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(socket.sent).toHaveLength(3);

    // Every resend stays well inside the 400ms lease -- two 150ms
    // ticks (300ms) is comfortably short of it.
    expect(sentMessages(socket).every((m) => (m as { verb: string }).verb === "WHEELS_V")).toBe(true);
  });

  it("sends STOP with no fields on release, and stops resending", () => {
    vi.useFakeTimers();
    const { el, socket } = mountControls(baseDevice());
    const forward = el.querySelector<HTMLButtonElement>('[data-testid="drive-forward"]')!;

    act(() => {
      forward.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(socket.sent).toHaveLength(2);

    act(() => {
      forward.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });

    const messages = sentMessages(socket);
    expect(messages[messages.length - 1]).toEqual({
      type: "send-command",
      endpointId: "usb-ROBOT-A",
      verb: "STOP",
    });

    const countAfterRelease = socket.sent.length;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(socket.sent.length).toBe(countAfterRelease);
  });

  it("stops (sends STOP) when the mouse leaves the button while held", () => {
    const { el, socket } = mountControls(baseDevice());
    const left = el.querySelector<HTMLButtonElement>('[data-testid="drive-left"]')!;

    act(() => {
      left.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    act(() => {
      // React derives its synthetic onMouseLeave from the native
      // "mouseout" event (with a `relatedTarget` outside this element),
      // not from a native "mouseleave" dispatch -- mirror that here
      // rather than dispatching a "mouseleave" event React never
      // listens for directly.
      left.dispatchEvent(
        new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }),
      );
    });

    const messages = sentMessages(socket);
    expect(messages).toEqual([
      { type: "send-command", endpointId: "usb-ROBOT-A", verb: "WHEELS_V", fields: [-150, 150, 400] },
      { type: "send-command", endpointId: "usb-ROBOT-A", verb: "STOP" },
    ]);
  });

  it("sends mirrored wheel velocities for turning right", () => {
    const { el, socket } = mountControls(baseDevice());
    const right = el.querySelector<HTMLButtonElement>('[data-testid="drive-right"]')!;

    act(() => {
      right.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(sentMessages(socket)).toEqual([
      { type: "send-command", endpointId: "usb-ROBOT-A", verb: "WHEELS_V", fields: [150, -150, 400] },
    ]);
  });

  it("sends negative wheel velocities for backward", () => {
    const { el, socket } = mountControls(baseDevice());
    const backward = el.querySelector<HTMLButtonElement>('[data-testid="drive-backward"]')!;

    act(() => {
      backward.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(sentMessages(socket)).toEqual([
      { type: "send-command", endpointId: "usb-ROBOT-A", verb: "WHEELS_V", fields: [-150, -150, 400] },
    ]);
  });

  it("sends STOP when DriveControls itself unmounts while held", async () => {
    const { el, socket, unmountDriveControls } = mountControlsRemovable(baseDevice());
    const forward = el.querySelector<HTMLButtonElement>('[data-testid="drive-forward"]')!;

    act(() => {
      forward.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(socket.sent).toHaveLength(1);

    await unmountDriveControls();

    const messages = sentMessages(socket);
    expect(messages[messages.length - 1]).toEqual({
      type: "send-command",
      endpointId: "usb-ROBOT-A",
      verb: "STOP",
    });
  });

  it("disables the pad with a hint when no session is open", () => {
    const { el } = mountControls(baseDevice({ sessionOpen: false }));

    expect(el.querySelector<HTMLButtonElement>('[data-testid="drive-forward"]')!.disabled).toBe(true);
    expect(el.textContent).toContain("No link open");
  });

  it("does not send anything when pressed with no session open", () => {
    const { el, socket } = mountControls(baseDevice({ sessionOpen: false }));
    const forward = el.querySelector<HTMLButtonElement>('[data-testid="drive-forward"]')!;

    act(() => {
      forward.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(socket.sent).toHaveLength(0);
  });
});
