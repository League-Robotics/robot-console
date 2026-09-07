// @vitest-environment jsdom
/**
 * DevicesTab.test.tsx — component-level tests for the Devices tab
 * (ticket 010 / SUC-001).
 *
 * Two layers, matching the ticket's testing note:
 *  - `DevicesList` (presentational) is exercised directly against
 *    plain `DeviceListEntry` data shaped exactly like a `type:
 *    'devices'` WebSocket message's payload -- normal row rendering,
 *    the unnamed/error flag, and the unresponsive-device case.
 *  - One test drives the real `WsProvider` against a fully synthetic
 *    fake socket (see `WebSocketLike`) and pushes an actual `{type:
 *    'devices', ...}` JSON message through it, proving the live
 *    "no manual refresh" wiring end to end.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { DeviceListEntry } from "@robot-console/host/src/wsMessages.js";
import { DevicesList, DevicesTab } from "./DevicesTab";
import { WsProvider, type WebSocketLike } from "../ws/WsProvider";

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

function baseDevice(overrides: Partial<DeviceListEntry> = {}): DeviceListEntry {
  return {
    id: "SERIAL-A",
    serialNumber: "SERIAL-A-FULL",
    displaySerial: "0002",
    name: "zeguz",
    role: "NEZHA2",
    port: "/dev/cu.usbmodemA",
    linkOpen: true,
    ...overrides,
  };
}

describe("DevicesList", () => {
  it("renders a normal device row with name, role, port, and device id", () => {
    const el = mount(
      <DevicesList
        status="open"
        devices={[baseDevice()]}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );

    const text = el.textContent ?? "";
    expect(text).toContain("zeguz");
    expect(text).toContain("NEZHA2");
    expect(text).toContain("/dev/cu.usbmodemA");
    expect(text).toContain("0002");
  });

  it("flags a device that failed SWD naming as unnamed/error, not omitted", () => {
    const el = mount(
      <DevicesList
        status="open"
        devices={[
          baseDevice({
            id: "SERIAL-B",
            name: null,
            role: null,
            nameError: { reason: "swd-attach-failed", message: "could not attach over SWD" },
          }),
        ]}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );

    const text = el.textContent ?? "";
    expect(text).toContain("Unnamed device");
    expect(text).toContain("could not attach over SWD");
    // Never omitted: the row itself must still be present.
    expect(el.querySelector('[data-testid="device-SERIAL-B"]')).not.toBeNull();
  });

  it("shows a device that never replied to HELLO as unresponsive, not assigned a role", () => {
    const el = mount(
      <DevicesList
        status="open"
        devices={[
          baseDevice({
            id: "SERIAL-C",
            role: null,
            linkOpen: false,
            linkError: "HELLO reply timed out after 2000ms",
          }),
        ]}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );

    const text = el.textContent ?? "";
    expect(text).toContain("Unresponsive");
    expect(text).toContain("HELLO reply timed out after 2000ms");
    // Must not show a raw role of null/"" nor a role token.
    expect(text).not.toContain("NEZHA2");
  });

  it("renders the realistic ground-truth board (name only, role null, silent link error) legibly", () => {
    const el = mount(
      <DevicesList
        status="open"
        devices={[
          baseDevice({
            id: "9906360200052820aba2e384f40cfd6c000000006e052820",
            serialNumber: "9906360200052820aba2e384f40cfd6c000000006e052820",
            displaySerial: "052820aba2e384f40cfd6c0",
            name: "zeguz",
            role: null,
            port: "/dev/cu.usbmodem2121102",
            linkOpen: false,
            linkError: "HELLO reply timed out after 2000ms",
          }),
        ]}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );

    const text = el.textContent ?? "";
    expect(text).toContain("zeguz");
    expect(text).toContain("Unresponsive");
    expect(text).toContain("/dev/cu.usbmodem2121102");
    // The displaySerial (unique middle field) is shown, not a truncated
    // prefix/suffix of the full serial that two boards could share.
    expect(text).toContain("052820aba2e384f40cfd6c0");
  });

  it("shows a device with no serial port as connectable-by-nothing rather than a broken button", () => {
    const el = mount(
      <DevicesList
        status="open"
        devices={[baseDevice({ id: "SERIAL-D", port: null, linkOpen: false })]}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );

    expect(el.textContent ?? "").toContain("No serial port available to connect");
    expect(el.querySelector("button")).toBeNull();
  });

  it("shows a reconnecting banner without dropping the last-known device list", () => {
    const el = mount(
      <DevicesList
        status="closed"
        devices={[baseDevice()]}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );

    const text = el.textContent ?? "";
    expect(text).toContain("reconnecting");
    expect(text).toContain("zeguz");
  });

  it("sends an open message when Connect is clicked on a closed device with a port", () => {
    const opened: string[] = [];
    const el = mount(
      <DevicesList
        status="open"
        devices={[baseDevice({ id: "SERIAL-E", linkOpen: false })]}
        onOpen={(id) => opened.push(id)}
        onClose={() => {}}
      />,
    );

    const button = el.querySelector("button");
    expect(button?.textContent).toBe("Connect");
    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(opened).toEqual(["SERIAL-E"]);
  });

  it("sends a close message when Disconnect is clicked on an open device", () => {
    const closed: string[] = [];
    const el = mount(
      <DevicesList
        status="open"
        devices={[baseDevice({ id: "SERIAL-F", linkOpen: true })]}
        onOpen={() => {}}
        onClose={(id) => closed.push(id)}
      />,
    );

    const button = el.querySelector("button");
    expect(button?.textContent).toBe("Disconnect");
    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(closed).toEqual(["SERIAL-F"]);
  });
});

/** A fully synthetic `WebSocketLike` for driving `WsProvider` in tests
 * without real network I/O or depending on jsdom implementing
 * `WebSocket` itself. */
class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  emitOpen(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  emitMessage(data: unknown): void {
    this.emit("message", { data: JSON.stringify(data) });
  }
}

describe("WsProvider end-to-end wiring", () => {
  it("renders a live 'devices' message pushed over the socket, with no manual refresh", () => {
    let socket: FakeSocket | null = null;
    const el = mount(
      <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
        <DevicesTabProbe />
      </WsProvider>,
    );

    expect(socket).not.toBeNull();
    act(() => {
      socket!.emitOpen();
    });
    expect(el.textContent).toContain("No devices detected yet");

    act(() => {
      socket!.emitMessage({
        type: "devices",
        devices: [baseDevice({ id: "SERIAL-LIVE", name: "kivon" })],
      });
    });

    expect(el.textContent).toContain("kivon");
  });
});

// Local probe component: exercises the real connected `DevicesTab`
// (which reads `useWs()`), rather than re-testing `DevicesList` again.
function DevicesTabProbe() {
  return <DevicesTab />;
}
