// @vitest-environment jsdom
/**
 * StatusPanel.test.tsx — component tests (ticket 005 / SUC-001, SUC-004).
 *
 * Proves: the button sends unsequenced `STATUS` with no fields via
 * `sendCommand`; the panel displays the most recent `status ...` reply
 * line, sourced from the same per-endpoint log `DeviceConsole` reads
 * (not a separate parsed structure); disabled with a hint when no
 * session is open.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
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

function mountPanel(device: EndpointListEntry): { el: HTMLDivElement; socket: FakeSocket } {
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

describe("StatusPanel", () => {
  it("sends unsequenced STATUS with no fields", () => {
    const { el, socket } = mountPanel(baseDevice());
    const button = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Send STATUS")!;

    act(() => {
      button.click();
    });

    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", endpointId: "usb-ROBOT-A", verb: "STATUS" }),
    ]);
  });

  it("shows a placeholder before any STATUS reply has arrived", () => {
    const { el } = mountPanel(baseDevice());
    expect(el.textContent).toContain("No STATUS reply yet.");
  });

  it("displays the most recent status reply line", () => {
    const { el, socket } = mountPanel(baseDevice());

    act(() => {
      socket.emitMessage({
        type: "line",
        endpointId: "usb-ROBOT-A",
        direction: "rx",
        line: "status ready=0 active=0 connL=0 connR=0 otos=0 wedge=0 flags=0 i2cf=0 cyc=0 tlm=off next=1 done=0 reason=none",
      });
    });

    expect(el.querySelector('[data-testid="status-panel-reply"]')?.textContent).toContain(
      "status ready=0 active=0",
    );
  });

  it("keeps the most recent status line when other traffic follows", () => {
    const { el, socket } = mountPanel(baseDevice());

    act(() => {
      socket.emitMessage({ type: "line", endpointId: "usb-ROBOT-A", direction: "rx", line: "status a=1" });
      socket.emitMessage({ type: "line", endpointId: "usb-ROBOT-A", direction: "rx", line: "ack 1 0 none" });
      socket.emitMessage({ type: "line", endpointId: "usb-ROBOT-A", direction: "rx", line: "status a=2" });
    });

    expect(el.querySelector('[data-testid="status-panel-reply"]')?.textContent).toContain("status a=2");
  });

  it("ignores a status-like line from a different endpoint", () => {
    const { el, socket } = mountPanel(baseDevice());

    act(() => {
      socket.emitMessage({ type: "line", endpointId: "usb-OTHER", direction: "rx", line: "status a=99" });
    });

    expect(el.querySelector('[data-testid="status-panel-reply"]')?.textContent).toContain(
      "No STATUS reply yet.",
    );
  });

  it("disables the button with a hint when no session is open", () => {
    const { el } = mountPanel(baseDevice({ sessionOpen: false }));
    const button = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Send STATUS")!;

    expect(button.disabled).toBe(true);
    expect(el.textContent).toContain("No link open");
  });
});
