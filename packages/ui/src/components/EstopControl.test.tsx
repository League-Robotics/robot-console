// @vitest-environment jsdom
/**
 * EstopControl.test.tsx — component tests (ticket 006 / SUC-002).
 *
 * Proves the command *plumbing* only, against a fake `WsProvider`
 * socket: pressing the control sends the exact unsequenced `ESTOP`
 * line, sending is never gated on `sequencing`/pending state, repeated
 * presses are harmless, and the control disables-with-a-hint (never
 * hides) when no session is open. **These tests do not and cannot
 * prove that a real robot stops moving** — that is a hardware-verified
 * safety claim, recorded separately as hardware-deferred, and is never
 * checked off by this suite.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { EstopControl } from "./EstopControl";
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

function mountControl(device: EndpointListEntry): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <EstopControl device={device} />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket! };
}

function sentMessages(socket: FakeSocket): unknown[] {
  return socket.sent.map((s) => JSON.parse(s));
}

describe("EstopControl", () => {
  it("renders unconditionally, reachable regardless of other state", () => {
    const { el } = mountControl(baseDevice());
    expect(el.querySelector('[aria-label="Emergency stop"]')).not.toBeNull();
    expect(el.querySelector<HTMLButtonElement>('[data-testid="estop-button"]')).not.toBeNull();
  });

  it("sends unsequenced ESTOP with no fields on press", () => {
    const { el, socket } = mountControl(baseDevice());
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
    // nonzero, exactly the state `DriveControls`'s resend loop leaves
    // an endpoint in while a direction is held. EstopControl must not
    // notice or care.
    const device = baseDevice({
      sequencing: { seq: 3, pendingCount: 1, lastDone: 2, lastDoneReason: "none" },
    });
    const { el, socket } = mountControl(device);
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
    const { el, socket } = mountControl(device);
    const button = el.querySelector<HTMLButtonElement>('[data-testid="estop-button"]')!;

    act(() => {
      button.click();
    });

    expect(sentMessages(socket)).toEqual([
      { type: "send-command", endpointId: "usb-ROBOT-A", verb: "ESTOP" },
    ]);
  });

  it("treats repeated presses as harmless -- each is an independent unsequenced send, never queued or blocked", () => {
    const { el, socket } = mountControl(baseDevice());
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
    const { el } = mountControl(baseDevice({ sessionOpen: false }));
    const button = el.querySelector<HTMLButtonElement>('[data-testid="estop-button"]')!;

    expect(button).not.toBeNull();
    expect(button.disabled).toBe(true);
    expect(el.textContent).toContain("No link open");
  });

  it("does not send anything when pressed with no session open", () => {
    const { el, socket } = mountControl(baseDevice({ sessionOpen: false }));
    const button = el.querySelector<HTMLButtonElement>('[data-testid="estop-button"]')!;

    act(() => {
      button.click();
    });

    expect(socket.sent).toHaveLength(0);
  });
});

describe("EstopControl Clear E-STOP (added out-of-process, 2026-09-09)", () => {
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
    const { el } = mountControl(baseDevice());
    expect(el.querySelector('[data-testid="estop-clear-button"]')).toBeNull();
  });

  it("is absent when robotStatus.estopped is false", () => {
    const { el } = mountControl(
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
    const { el, socket } = mountControl(estoppedDevice());
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
    const { el } = mountControl(estoppedDevice({ sessionOpen: false }));
    const button = el.querySelector<HTMLButtonElement>('[data-testid="estop-clear-button"]')!;
    expect(button.disabled).toBe(true);
  });
});
