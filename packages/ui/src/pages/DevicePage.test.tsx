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
    classification: { type: "unknown", role: null, commonName: null, dialect: null, evidence: "none", program: null, version: null },
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

/** A WiFi-reachable robot's endpoint (sprint 10 ticket 005 fix-up),
 * mirroring `FrontPage.test.tsx`'s own wifi fixture shape:
 * `endpointId: "wifi-<name>"`, `transport: "wifi"`, a `wifi: { host,
 * port }` block, no `usb` block. Defaults to not-yet-open and
 * identified, matching the common "just navigated here" case this
 * ticket fixes. */
function wifiEndpoint(overrides: Partial<EndpointListEntry> = {}): EndpointListEntry {
  return {
    endpointId: "wifi-gopiv",
    transport: "wifi",
    resourceKey: "wifi-gopiv",
    classification: { type: "unknown", role: null, commonName: null, dialect: null, evidence: "none", program: null, version: null },
    name: "gopiv",
    role: null,
    sessionOpen: false,
    wifi: { host: "192.168.1.42", port: 8765 },
    ...overrides,
  };
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

  it("shows a distinct 'not connected' state once the snapshot arrives without this endpoint", () => {
    // The way back to "/" is no longer rendered by DevicePage itself --
    // ticket 012-004's AppHeader is the single source of that control
    // now, covered by AppHeader.test.tsx.
    const { el, socket } = mountAt("/d/usb-MISSING");
    act(() => {
      socket().emitOpen();
    });
    act(() => {
      socket().emitMessage({ type: "endpoints", endpoints: [endpoint()] });
    });

    expect(el.textContent).not.toContain("Looking for this device");
    expect(el.textContent).toContain("isn't connected");
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
            classification: { type: "relay", role: "RADIORELAY", commonName: "relay", dialect: "space", evidence: "role", program: null, version: null },
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
            classification: { type: "robot", role: "NEZHA2", commonName: "robot", dialect: "space", evidence: "role", program: null, version: null },
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
              evidence: "role", program: null, version: null,
            },
          }),
        ],
      });
    });

    expect(el.querySelector('[aria-label="Unknown device"]')).not.toBeNull();
  });
});

describe("DevicePage opens a wifi endpoint's session on mount (sprint 10 ticket 005 fix-up)", () => {
  it("sends exactly one session-open for a not-yet-open wifi endpoint on mount", () => {
    const { el, socket } = mountAt("/d/wifi-gopiv");
    act(() => {
      socket().emitOpen();
    });
    act(() => {
      socket().emitMessage({ type: "endpoints", endpoints: [wifiEndpoint()] });
    });

    expect(el.textContent).toContain("gopiv");
    expect(socket().sent).toEqual([JSON.stringify({ type: "session-open", endpointId: "wifi-gopiv" })]);
  });

  it("sends no session-open for a wifi endpoint that is already open", () => {
    const { socket } = mountAt("/d/wifi-gopiv");
    act(() => {
      socket().emitOpen();
    });
    act(() => {
      socket().emitMessage({
        type: "endpoints",
        endpoints: [
          wifiEndpoint({
            classification: { type: "robot", role: "NEZHA2", commonName: "robot", dialect: "space", evidence: "role", program: null, version: null },
            role: "NEZHA2",
            sessionOpen: true,
          }),
        ],
      });
    });

    // Already-open triggers RobotPage's own child panels (StatusPanel's
    // STATUS poll, FunctionsPanel's discovery GET) to send their usual
    // opening traffic -- unrelated to this fix. Only session-open itself
    // is this test's concern.
    expect(socket().sent).not.toContain(JSON.stringify({ type: "session-open", endpointId: "wifi-gopiv" }));
  });

  it("sends no session-open for a wifi endpoint with a sessionError set -- does not loop on a failed attempt", () => {
    const { socket } = mountAt("/d/wifi-gopiv");
    act(() => {
      socket().emitOpen();
    });
    act(() => {
      socket().emitMessage({
        type: "endpoints",
        endpoints: [wifiEndpoint({ sessionError: "HELLO reply timed out after 2000ms" })],
      });
    });

    expect(socket().sent).toEqual([]);
  });

  it("sends no session-open for a not-yet-open usb endpoint -- the host already auto-opens USB on attach", () => {
    const { socket } = mountAt("/d/usb-SERIAL-A");
    act(() => {
      socket().emitOpen();
    });
    act(() => {
      socket().emitMessage({ type: "endpoints", endpoints: [endpoint({ sessionOpen: false })] });
    });

    expect(socket().sent).toEqual([]);
  });
});
