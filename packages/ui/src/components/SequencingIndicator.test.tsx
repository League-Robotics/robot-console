// @vitest-environment jsdom
/**
 * SequencingIndicator.test.tsx — component tests (ticket 005 / SUC-003).
 *
 * Covers both states this component can render: the populated case
 * (once an `endpoints` snapshot carries `sequencing` for an open
 * session) and the explicit "no session" case (before any snapshot, or
 * once `sequencing` is absent because no session is open) -- per this
 * component's own doc comment, `useSequencing` returning `undefined` is
 * an ordinary value here, not an error, and must render as a clear
 * statement rather than blank space.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { SequencingIndicator } from "./SequencingIndicator";
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

function robotEntry(overrides: Partial<EndpointListEntry> = {}): EndpointListEntry {
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

function mountIndicator(): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <SequencingIndicator endpointId="usb-ROBOT-A" />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket! };
}

describe("SequencingIndicator", () => {
  it("shows an explicit 'no session' state before any snapshot has arrived", () => {
    const { el } = mountIndicator();
    expect(el.textContent).toMatch(/no session/i);
  });

  it("shows an explicit 'no session' state when the endpoint has no open session", () => {
    const { el, socket } = mountIndicator();
    act(() => {
      socket.emitMessage({
        type: "endpoints",
        endpoints: [robotEntry({ sessionOpen: false })],
        firmwareStatus: { relay: { configured: false }, robot: { configured: false } },
        rememberedRobots: [],
      });
    });
    expect(el.textContent).toMatch(/no session/i);
  });

  it("renders seq/pendingCount/lastDone/lastDoneReason from the snapshot", () => {
    const { el, socket } = mountIndicator();
    act(() => {
      socket.emitMessage({
        type: "endpoints",
        endpoints: [
          {
            ...robotEntry(),
            sequencing: { seq: 3, pendingCount: 1, lastDone: 2, lastDoneReason: "none" },
          },
        ],
        firmwareStatus: { relay: { configured: false }, robot: { configured: false } },
        rememberedRobots: [],
      });
    });
    expect(el.textContent).not.toMatch(/no session/i);
    expect(el.textContent).toContain("3");
    expect(el.textContent).toContain("1");
    expect(el.textContent).toContain("2");
    expect(el.textContent).toContain("none");
  });

  it("updates when a fresh snapshot changes sequencing state", () => {
    const { el, socket } = mountIndicator();
    act(() => {
      socket.emitMessage({
        type: "endpoints",
        endpoints: [
          { ...robotEntry(), sequencing: { seq: 1, pendingCount: 1, lastDone: 0, lastDoneReason: "none" } },
        ],
        firmwareStatus: { relay: { configured: false }, robot: { configured: false } },
        rememberedRobots: [],
      });
    });
    expect(el.textContent).toContain("1");

    act(() => {
      socket.emitMessage({
        type: "endpoints",
        endpoints: [
          { ...robotEntry(), sequencing: { seq: 2, pendingCount: 0, lastDone: 2, lastDoneReason: "ok" } },
        ],
        firmwareStatus: { relay: { configured: false }, robot: { configured: false } },
        rememberedRobots: [],
      });
    });
    expect(el.textContent).toContain("2");
    expect(el.textContent).toContain("ok");
  });
});
