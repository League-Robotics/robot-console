// @vitest-environment jsdom
/**
 * DevicePage.test.tsx — router-level tests for `/d/:endpointId`
 * (ticket 007, SUC-001's alternate flow).
 *
 * Covers the `hasSnapshot` loading-vs-not-found distinction (a deep
 * link before the first `endpoints` snapshot must not flash "not
 * connected" for a device that may well be attached) and the
 * no-auto-redirect rule for an endpoint that disappears while its page
 * is open.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { AppRoutes } from "../router";
import { WsProvider } from "../ws/WsProvider";
import { FakeSocket } from "../testing/FakeSocket";
import { withRouter } from "../testing/renderWithRouter";

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

function endpoint(overrides: Partial<EndpointListEntry> = {}): EndpointListEntry {
  return {
    endpointId: "usb-SERIAL-A",
    transport: "usb",
    resourceKey: "usb-SERIAL-A",
    classification: { type: "unknown", role: null, commonName: null, dialect: null, evidence: "none" },
    name: "zeguz",
    role: null,
    sessionOpen: false,
    usb: { serialNumber: "SERIAL-A-FULL", displaySerial: "0002", port: "/dev/cu.usbmodemA" },
    ...overrides,
  };
}

function mountAt(initialPath: string): { el: HTMLDivElement; socket: () => FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    withRouter(
      <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
        <AppRoutes />
      </WsProvider>,
      { initialEntries: [initialPath] },
    ),
  );
  return { el, socket: () => socket! };
}

describe("DevicePage deep-linking", () => {
  it("shows a loading state, not 'not connected', before the first snapshot arrives", () => {
    const { el, socket } = mountAt("/d/usb-SERIAL-A");
    act(() => {
      socket().emitOpen();
    });

    expect(el.textContent).toContain("Looking for this device");
    expect(el.textContent).not.toContain("isn't connected");
  });

  it("shows a distinct 'not connected' state, with a way back, once the snapshot arrives without this endpoint", () => {
    const { el, socket } = mountAt("/d/usb-MISSING");
    act(() => {
      socket().emitOpen();
    });
    act(() => {
      socket().emitMessage({ type: "endpoints", endpoints: [endpoint()] });
    });

    expect(el.textContent).not.toContain("Looking for this device");
    expect(el.textContent).toContain("isn't connected");
    const back = el.querySelector("a");
    expect(back?.getAttribute("href")).toBe("/");
  });

  it("renders the matched endpoint once the snapshot includes it", () => {
    const { el, socket } = mountAt("/d/usb-SERIAL-A");
    act(() => {
      socket().emitOpen();
    });
    act(() => {
      socket().emitMessage({ type: "endpoints", endpoints: [endpoint({ name: "kivon" })] });
    });

    expect(el.textContent).toContain("kivon");
  });

  it("does not redirect when the open endpoint disappears from a later snapshot", () => {
    const { el, socket } = mountAt("/d/usb-SERIAL-A");
    act(() => {
      socket().emitOpen();
    });
    act(() => {
      socket().emitMessage({ type: "endpoints", endpoints: [endpoint({ name: "kivon" })] });
    });
    expect(el.textContent).toContain("kivon");

    act(() => {
      socket().emitMessage({ type: "endpoints", endpoints: [] });
    });

    expect(el.querySelector('[data-testid="location"]')?.textContent).toBe("/d/usb-SERIAL-A");
    expect(el.textContent).toContain("isn't connected");
  });
});

describe("DevicePage per-type dispatch", () => {
  it("dispatches a relay-classified endpoint to RelayPage", () => {
    const { el, socket } = mountAt("/d/usb-SERIAL-A");
    act(() => {
      socket().emitOpen();
    });
    act(() => {
      socket().emitMessage({
        type: "endpoints",
        endpoints: [
          endpoint({
            classification: { type: "relay", role: "RADIORELAY", commonName: "relay", dialect: "space", evidence: "role" },
          }),
        ],
      });
    });

    expect(el.querySelector('[aria-label="Relay device"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="relay-robot-select"]')).not.toBeNull();
  });

  it("dispatches a robot-classified endpoint to RobotPage", () => {
    const { el, socket } = mountAt("/d/usb-SERIAL-A");
    act(() => {
      socket().emitOpen();
    });
    act(() => {
      socket().emitMessage({
        type: "endpoints",
        endpoints: [
          endpoint({
            classification: { type: "robot", role: "NEZHA2", commonName: "robot", dialect: "space", evidence: "role" },
          }),
        ],
      });
    });

    expect(el.querySelector('[aria-label="Robot device"]')).not.toBeNull();
  });

  it("dispatches an unknown-classified endpoint to UnknownDevicePage", () => {
    const { el, socket } = mountAt("/d/usb-SERIAL-A");
    act(() => {
      socket().emitOpen();
    });
    act(() => {
      socket().emitMessage({ type: "endpoints", endpoints: [endpoint()] });
    });

    expect(el.querySelector('[aria-label="Unknown device"]')).not.toBeNull();
  });

  it("dispatches an unrecognized classification.type to UnknownDevicePage via the default arm", () => {
    // The "a fourth device type is purely additive" contract
    // (`wsMessages.ts`'s module doc comment): a client built against
    // today's two-type union must treat any value it doesn't recognize
    // as unknown, not crash or render nothing.
    const { el, socket } = mountAt("/d/usb-SERIAL-A");
    act(() => {
      socket().emitOpen();
    });
    act(() => {
      socket().emitMessage({
        type: "endpoints",
        endpoints: [
          endpoint({
            classification: {
              type: "calibration" as unknown as EndpointListEntry["classification"]["type"],
              role: "SOMETHING_NEW",
              commonName: null,
              dialect: null,
              evidence: "role",
            },
          }),
        ],
      });
    });

    expect(el.querySelector('[aria-label="Unknown device"]')).not.toBeNull();
  });
});
