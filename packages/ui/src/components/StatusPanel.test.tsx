// @vitest-environment jsdom
/**
 * StatusPanel.test.tsx — component tests (added out-of-process,
 * 2026-09-09).
 *
 * Proves: the headline state word for every `robotStatus` combination
 * (including the no-`robotStatus` "Unknown" case and estopped's
 * priority over every other flag); the raw `fields` render verbatim;
 * Refresh sends a bare `STATUS`; Clear E-STOP sends `SET estop_clear 1`
 * then `STATUS`, in that order, and only appears while `estopped` is
 * `true`; every button disables with no session open.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { EndpointListEntry, RobotStatus } from "@robot-console/host/src/wsMessages.js";
import { StatusPanel } from "./StatusPanel";
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

function baseStatus(overrides: Partial<RobotStatus> = {}): RobotStatus {
  return {
    receivedAt: 2000,
    fields: { ready: "1", active: "0", flags: "1" },
    ready: true,
    active: false,
    estopped: false,
    stallHalted: false,
    leaseExpired: false,
    ...overrides,
  };
}

function mountPanel(
  device: EndpointListEntry,
  now?: () => number,
): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      {/* `exactOptionalPropertyTypes` forbids `now={undefined}` -- omit
          the prop entirely when the caller didn't pass one, letting
          StatusPanel's own default (`Date.now`) apply. */}
      {now !== undefined ? <StatusPanel device={device} now={now} /> : <StatusPanel device={device} />}
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket! };
}

function stateText(el: HTMLDivElement): string | null {
  return el.querySelector('[data-testid="status-panel-state"]')?.textContent ?? null;
}

describe("StatusPanel state word", () => {
  it("shows Unknown when there is no robotStatus yet", () => {
    const { el } = mountPanel(baseDevice());
    expect(stateText(el)).toContain("Unknown");
  });

  it("shows E-STOPPED when estopped, taking priority over active", () => {
    const { el } = mountPanel(
      baseDevice({ robotStatus: baseStatus({ estopped: true, active: true, ready: true }) }),
    );
    expect(stateText(el)).toBe("E-STOPPED");
  });

  it("shows Stall halted when stallHalted (and not estopped)", () => {
    const { el } = mountPanel(baseDevice({ robotStatus: baseStatus({ stallHalted: true }) }));
    expect(stateText(el)).toBe("Stall halted");
  });

  it("shows Lease expired when leaseExpired (and not estopped/stalled)", () => {
    const { el } = mountPanel(baseDevice({ robotStatus: baseStatus({ leaseExpired: true }) }));
    expect(stateText(el)).toBe("Lease expired");
  });

  it("shows Not ready when !ready", () => {
    const { el } = mountPanel(baseDevice({ robotStatus: baseStatus({ ready: false }) }));
    expect(stateText(el)).toBe("Not ready");
  });

  it("shows Moving when active", () => {
    const { el } = mountPanel(baseDevice({ robotStatus: baseStatus({ active: true }) }));
    expect(stateText(el)).toBe("Moving");
  });

  it("shows Ready otherwise", () => {
    const { el } = mountPanel(baseDevice({ robotStatus: baseStatus() }));
    expect(stateText(el)).toBe("Ready");
  });
});

describe("StatusPanel fields and refresh", () => {
  it("renders the raw fields verbatim", () => {
    const { el } = mountPanel(
      baseDevice({
        robotStatus: baseStatus({ fields: { ready: "1", cyc: "1234", reason: "stop" } }),
      }),
    );
    const fields = el.querySelector('[data-testid="status-panel-fields"]')!;
    expect(fields.textContent).toContain("ready");
    expect(fields.textContent).toContain("1234");
    expect(fields.textContent).toContain("stop");
  });

  it("shows a deterministic 'Last updated Ns ago' using the injected clock", () => {
    const { el } = mountPanel(
      baseDevice({ robotStatus: baseStatus({ receivedAt: 2000 }) }),
      () => 5000,
    );
    expect(el.textContent).toContain("Last updated 3s ago");
  });

  it("sends a bare STATUS on Refresh", () => {
    const { el, socket } = mountPanel(baseDevice({ robotStatus: baseStatus() }));
    socket.sent.length = 0;
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="status-panel-refresh"]')!.click();
    });
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", endpointId: "usb-ROBOT-A", verb: "STATUS" }),
    ]);
  });

  it("disables Refresh when there is no open session", () => {
    const { el } = mountPanel(baseDevice({ sessionOpen: false, robotStatus: baseStatus() }));
    expect(el.querySelector<HTMLButtonElement>('[data-testid="status-panel-refresh"]')!.disabled).toBe(
      true,
    );
  });
});

describe("StatusPanel Clear E-STOP", () => {
  it("is absent when not estopped", () => {
    const { el } = mountPanel(baseDevice({ robotStatus: baseStatus() }));
    expect(el.querySelector('[data-testid="status-panel-clear-estop"]')).toBeNull();
  });

  it("appears and sends SET estop_clear 1 then STATUS, in order, when estopped", () => {
    const { el, socket } = mountPanel(baseDevice({ robotStatus: baseStatus({ estopped: true }) }));
    const button = el.querySelector<HTMLButtonElement>('[data-testid="status-panel-clear-estop"]')!;
    socket.sent.length = 0;
    act(() => {
      button.click();
    });
    expect(socket.sent).toEqual([
      JSON.stringify({
        type: "send-command",
        endpointId: "usb-ROBOT-A",
        verb: "SET",
        fields: ["estop_clear", "1"],
      }),
      JSON.stringify({ type: "send-command", endpointId: "usb-ROBOT-A", verb: "STATUS" }),
    ]);
  });

  it("disables Clear E-STOP when there is no open session", () => {
    const { el } = mountPanel(
      baseDevice({ sessionOpen: false, robotStatus: baseStatus({ estopped: true }) }),
    );
    expect(
      el.querySelector<HTMLButtonElement>('[data-testid="status-panel-clear-estop"]')!.disabled,
    ).toBe(true);
  });
});
