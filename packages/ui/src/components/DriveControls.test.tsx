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
 *
 * **Out-of-process, 2026-09-10**: this file also carries the STOP/
 * E-STOP/Clear E-STOP tests formerly in the now-deleted
 * `EstopControl.test.tsx` (their intent is unchanged, only the mounted
 * component is different -- `DriveControls` instead of a standalone
 * `EstopControl`), plus new tests for the four fixed-angle turn buttons
 * (`turn-90-left`/`turn-90-right`/`turn-180-left`/`turn-180-right`):
 * each is a one-shot click that sends exactly one `MOVE_X`, and all four
 * are disabled with no session open.
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
    classification: { type: "robot", role: "NEZHA2", commonName: "robot", dialect: "space", evidence: "role", program: null, version: null },
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

describe("DriveControls STOP (non-latching, ported from EstopControl.test.tsx, out-of-process 2026-09-10)", () => {
  it("sends STOP now on press, and nothing else when the robot has no abort function", () => {
    const { el, socket } = mountControls(baseDevice());
    socket.sent.length = 0;
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="stop-button"]')!.click();
    });
    expect(sentMessages(socket)).toEqual([
      { type: "send-command", endpointId: "usb-ROBOT-A", verb: "STOP", fields: ["now"] },
    ]);
  });

  it("also sends RUN abort when the robot's function list includes abort", () => {
    const { el, socket } = mountControls(baseDevice({ functions: [{ name: "clearestop" }, { name: "abort" }] }));
    socket.sent.length = 0;
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="stop-button"]')!.click();
    });
    expect(sentMessages(socket)).toEqual([
      { type: "send-command", endpointId: "usb-ROBOT-A", verb: "STOP", fields: ["now"] },
      { type: "send-command", endpointId: "usb-ROBOT-A", verb: "RUN", fields: ["abort"] },
    ]);
  });

  it("is disabled with no session open", () => {
    const { el } = mountControls(baseDevice({ sessionOpen: false }));
    expect(el.querySelector<HTMLButtonElement>('[data-testid="stop-button"]')!.disabled).toBe(true);
  });
});

describe("DriveControls E-STOP (ported from EstopControl.test.tsx, out-of-process 2026-09-10)", () => {
  it("sends unsequenced ESTOP with no fields on press", () => {
    const { el, socket } = mountControls(baseDevice());
    const button = el.querySelector<HTMLButtonElement>('[data-testid="estop-button"]')!;

    act(() => {
      button.click();
    });

    expect(sentMessages(socket)).toEqual([
      { type: "send-command", endpointId: "usb-ROBOT-A", verb: "ESTOP" },
    ]);
  });

  it("remains reachable and sends immediately while another panel has a pending sequenced WHEELS_V", () => {
    // A device snapshot mid-drive-lease: `sequencing.pendingCount` is
    // nonzero, exactly the state this component's own resend loop
    // leaves an endpoint in while a direction is held. E-STOP must not
    // notice or care.
    const device = baseDevice({
      sequencing: { seq: 3, pendingCount: 1, lastDone: 2, lastDoneReason: "none" },
    });
    const { el, socket } = mountControls(device);
    const button = el.querySelector<HTMLButtonElement>('[data-testid="estop-button"]')!;

    expect(button.disabled).toBe(false);

    act(() => {
      button.click();
    });

    expect(sentMessages(socket)).toEqual([
      { type: "send-command", endpointId: "usb-ROBOT-A", verb: "ESTOP" },
    ]);
  });

  it("remains reachable and sends immediately while a GET is pending", () => {
    const device = baseDevice({
      sequencing: { seq: 5, pendingCount: 2, lastDone: 3, lastDoneReason: "none" },
    });
    const { el, socket } = mountControls(device);
    const button = el.querySelector<HTMLButtonElement>('[data-testid="estop-button"]')!;

    act(() => {
      button.click();
    });

    expect(sentMessages(socket)).toEqual([
      { type: "send-command", endpointId: "usb-ROBOT-A", verb: "ESTOP" },
    ]);
  });

  it("treats repeated presses as harmless -- each is an independent unsequenced send, never queued or blocked", () => {
    const { el, socket } = mountControls(baseDevice());
    const button = el.querySelector<HTMLButtonElement>('[data-testid="estop-button"]')!;

    act(() => {
      button.click();
    });
    act(() => {
      button.click();
    });
    act(() => {
      button.click();
    });

    expect(sentMessages(socket)).toEqual([
      { type: "send-command", endpointId: "usb-ROBOT-A", verb: "ESTOP" },
      { type: "send-command", endpointId: "usb-ROBOT-A", verb: "ESTOP" },
      { type: "send-command", endpointId: "usb-ROBOT-A", verb: "ESTOP" },
    ]);
    // Still enabled and clickable after repeated presses -- no
    // disable-after-click, no cooldown, no error state.
    expect(button.disabled).toBe(false);
  });

  it("disables with a hint (not hidden) when no session is open", () => {
    const { el } = mountControls(baseDevice({ sessionOpen: false }));
    const button = el.querySelector<HTMLButtonElement>('[data-testid="estop-button"]')!;

    expect(button).not.toBeNull();
    expect(button.disabled).toBe(true);
    expect(el.textContent).toContain("No link open");
  });

  it("does not send anything when pressed with no session open", () => {
    const { el, socket } = mountControls(baseDevice({ sessionOpen: false }));
    const button = el.querySelector<HTMLButtonElement>('[data-testid="estop-button"]')!;

    act(() => {
      button.click();
    });

    expect(socket.sent).toHaveLength(0);
  });
});

describe("DriveControls Clear E-STOP (ported from EstopControl.test.tsx, out-of-process 2026-09-10)", () => {
  function estoppedDevice(overrides: Partial<EndpointListEntry> = {}): EndpointListEntry {
    return baseDevice({
      robotStatus: {
        receivedAt: 1000,
        fields: { flags: "3" },
        ready: true,
        active: false,
        estopped: true,
        stallHalted: false,
        leaseExpired: false,
      },
      ...overrides,
    });
  }

  it("is absent when robotStatus is missing", () => {
    const { el } = mountControls(baseDevice());
    expect(el.querySelector('[data-testid="estop-clear-button"]')).toBeNull();
  });

  it("is absent when robotStatus.estopped is false", () => {
    const { el } = mountControls(
      baseDevice({
        robotStatus: {
          receivedAt: 1000,
          fields: {},
          ready: true,
          active: false,
          estopped: false,
          stallHalted: false,
          leaseExpired: false,
        },
      }),
    );
    expect(el.querySelector('[data-testid="estop-clear-button"]')).toBeNull();
  });

  it("appears when robotStatus.estopped is true and sends SET estop_clear 1 then STATUS", () => {
    const { el, socket } = mountControls(estoppedDevice());
    const button = el.querySelector<HTMLButtonElement>('[data-testid="estop-clear-button"]')!;
    expect(button).not.toBeNull();

    act(() => {
      button.click();
    });

    expect(sentMessages(socket)).toEqual([
      {
        type: "send-command",
        endpointId: "usb-ROBOT-A",
        verb: "SET",
        fields: ["estop_clear", "1"],
      },
      { type: "send-command", endpointId: "usb-ROBOT-A", verb: "STATUS" },
    ]);
  });

  it("disables Clear E-STOP when no session is open", () => {
    const { el } = mountControls(estoppedDevice({ sessionOpen: false }));
    const button = el.querySelector<HTMLButtonElement>('[data-testid="estop-clear-button"]')!;
    expect(button.disabled).toBe(true);
  });
});

describe("DriveControls fixed-angle turns (MOVE_X, added out-of-process 2026-09-10)", () => {
  // Field 2 is milliradians, not degrees (`MOVE_X`'s wire contract --
  // see DriveControls.tsx's doc comment and the bench capture that
  // caught the earlier degrees-on-the-wire bug,
  // vendor/pxt-nezha-diffdrive/captures/bench-acceptance-029-20260904/
  // notes.md:95): 1571 = round(90 * pi / 180 * 1000), 3142 = round(180 *
  // pi / 180 * 1000). Field 3 (cruise) is 0 -- the wire's own "use the
  // robot's configured default cruise" sentinel, not an mm/s value.
  const cases: Array<{ testId: string; fields: [number, number, number, number] }> = [
    { testId: "turn-90-left", fields: [0, 1571, 0, 4000] },
    { testId: "turn-90-right", fields: [0, -1571, 0, 4000] },
    { testId: "turn-180-left", fields: [0, 3142, 0, 6000] },
    { testId: "turn-180-right", fields: [0, -3142, 0, 6000] },
  ];

  for (const { testId, fields } of cases) {
    it(`${testId} sends exactly one MOVE_X with fields ${JSON.stringify(fields)} on click`, () => {
      const { el, socket } = mountControls(baseDevice());
      const button = el.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!;

      act(() => {
        button.click();
      });

      expect(sentMessages(socket)).toEqual([
        { type: "send-command", endpointId: "usb-ROBOT-A", verb: "MOVE_X", fields },
      ]);
    });

    it(`${testId} sends nothing more on a second click -- one click, one MOVE_X`, () => {
      const { el, socket } = mountControls(baseDevice());
      const button = el.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!;

      act(() => {
        button.click();
      });
      act(() => {
        button.click();
      });

      expect(sentMessages(socket)).toEqual([
        { type: "send-command", endpointId: "usb-ROBOT-A", verb: "MOVE_X", fields },
        { type: "send-command", endpointId: "usb-ROBOT-A", verb: "MOVE_X", fields },
      ]);
    });

    it(`${testId} is disabled and sends nothing with no session open`, () => {
      const { el, socket } = mountControls(baseDevice({ sessionOpen: false }));
      const button = el.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!;

      expect(button.disabled).toBe(true);

      act(() => {
        button.click();
      });

      expect(socket.sent).toHaveLength(0);
    });
  }

  it("gives each turn button an explicit, icon-independent aria-label", () => {
    const { el } = mountControls(baseDevice());
    expect(el.querySelector('[data-testid="turn-90-left"]')!.getAttribute("aria-label")).toBe(
      "Turn 90 degrees left",
    );
    expect(el.querySelector('[data-testid="turn-90-right"]')!.getAttribute("aria-label")).toBe(
      "Turn 90 degrees right",
    );
    expect(el.querySelector('[data-testid="turn-180-left"]')!.getAttribute("aria-label")).toBe(
      "Turn 180 degrees left",
    );
    expect(el.querySelector('[data-testid="turn-180-right"]')!.getAttribute("aria-label")).toBe(
      "Turn 180 degrees right",
    );
  });
});
