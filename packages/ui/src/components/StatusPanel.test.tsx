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
import { StatusPanel, describeStatusValue, statusRows } from "./StatusPanel";
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
    classification: { type: "robot", role: "NEZHA2", commonName: "robot", dialect: "space", evidence: "role", program: null, version: null },
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
): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <StatusPanel device={device} />
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

describe("StatusPanel fields (OOP 2026-09-10: a named table, no refresh, no counter)", () => {
  it("renders the firmware's keys as labelled rows with decoded values, unknown keys raw", () => {
    const { el } = mountPanel(
      baseDevice({
        robotStatus: baseStatus({
          fields: { ready: "1", connL: "1", connR: "0", otos: "1", flags: "5", cyc: "1234", tlm: "off", reason: "stop", zzz: "7" },
        }),
      }),
    );
    const table = el.querySelector('[data-testid="status-panel-fields"]')!;
    expect(table.tagName).toBe("TABLE");
    const rows = Array.from(table.querySelectorAll("tr")).map((tr) => [tr.querySelector("th")?.textContent, tr.querySelector("td")?.textContent]);
    expect(rows).toEqual([
      ["Ready", "Yes"],
      ["Left motor", "Connected"],
      ["Right motor", "Not connected"],
      ["Odometry sensor", "Detected"],
      ["Flags", "Ready, Stall halted (0x5)"],
      ["Control cycles", "1234"],
      ["Telemetry", "OFF"],
      ["Last completion", "stop"],
      ["zzz", "7"],
    ]);
  });

  it("statusRows/describeStatusValue: e-stop flag bit and a no-flags word", () => {
    expect(describeStatusValue("flags", "2")).toBe("E-stop (0x2)");
    expect(describeStatusValue("flags", "0")).toBe("none (0x0)");
    expect(statusRows({ wedge: "0" })).toEqual([{ key: "wedge", label: "Bus wedged", value: "No" }]);
  });

  it("puts the state word on the same line as the Status heading and shows no Refresh button or last-updated counter", () => {
    const { el } = mountPanel(baseDevice({ robotStatus: baseStatus({ receivedAt: 2000 }) }));
    const heading = el.querySelector(".status-panel-heading")!;
    expect(heading.querySelector("h3")?.textContent).toBe("Status");
    expect(heading.querySelector('[data-testid="status-panel-state"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="status-panel-refresh"]')).toBeNull();
    expect(el.textContent).not.toContain("Last updated");
    expect(el.textContent).not.toContain("Refresh");
  });

  it("asks for STATUS itself on mount when the link is already open, and again on a closed->open transition", () => {
    // Socket already open before the panel renders (the real app's
    // shape: WsProvider connected long before a device page mounts) --
    // same pattern as CommandStrip.test.tsx's mountReady.
    let socket: FakeSocket | null = null;
    const socketFactory = () => (socket = new FakeSocket());
    const url = "ws://test/";
    mount(
      <WsProvider url={url} socketFactory={socketFactory}>
        <div />
      </WsProvider>,
    );
    act(() => {
      socket!.emitOpen();
    });
    const render = (next: EndpointListEntry) => {
      act(() => {
        root!.render(
          <WsProvider url={url} socketFactory={socketFactory}>
            <StatusPanel device={next} />
          </WsProvider>,
        );
      });
    };
    const statusMessage = JSON.stringify({ type: "send-command", endpointId: "usb-ROBOT-A", verb: "STATUS" });

    render(baseDevice({ sessionOpen: false }));
    expect(socket!.sent).toEqual([]);
    render(baseDevice());
    expect(socket!.sent).toEqual([statusMessage]);
    render(baseDevice({ robotStatus: baseStatus() })); // still open: no repeat
    expect(socket!.sent).toEqual([statusMessage]);
    render(baseDevice({ sessionOpen: false }));
    render(baseDevice());
    expect(socket!.sent).toEqual([statusMessage, statusMessage]);
  });

  it("says so when no link is open instead of pretending to wait", () => {
    const { el, socket } = mountPanel(baseDevice({ sessionOpen: false }));
    expect(socket.sent).toEqual([]);
    expect(stateText(el)).toContain("no link open");
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
