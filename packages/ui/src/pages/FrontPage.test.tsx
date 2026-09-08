// @vitest-environment jsdom
/**
 * FrontPage.test.tsx — component-level tests for the front page
 * (ticket 007 / SUC-001).
 *
 * Presentational assertions here are migrated from
 * `DevicesTab.test.tsx`'s `DevicesList` suite (normal row, flagged/
 * unnamed, unresponsive, no serial port, empty state, reconnecting
 * banner) -- nothing about *what* a row shows changed, only *what a
 * row does when clicked* (a real navigation, dropped Connect/
 * Disconnect/flash actions). The Connect/Disconnect/flash-button
 * assertions are **not** migrated -- those controls move to the
 * per-device page in ticket 008 and stay covered by
 * `DevicesTab.test.tsx` in the meantime (that component is left in
 * place, just unrouted from `App.tsx`).
 *
 * Two layers, matching `DevicesTab.test.tsx`'s own split:
 *  - `EndpointsList` (presentational) exercised directly against
 *    plain `EndpointListEntry` fixtures.
 *  - One test drives the real `FrontPage` through `WsProvider` +
 *    `AppRoutes`, against a fake socket, proving a card click performs
 *    a real router navigation to the clicked endpoint's page.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { EndpointsList } from "./FrontPage";
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

/** Convenience shape for fixture construction -- mirrors
 * `DevicesTab.test.tsx`'s `baseDevice`. */
interface BaseDeviceOverrides {
  id?: string;
  serialNumber?: string;
  displaySerial?: string;
  name?: string | null;
  role?: string | null;
  port?: string | null;
  linkOpen?: boolean;
  linkError?: string;
  nameError?: { reason: string; message: string };
}

function classificationFor(role: string | null): EndpointListEntry["classification"] {
  if (role === null) {
    return { type: "unknown", role: null, commonName: null, dialect: null, evidence: "none" };
  }
  if (role === "NEZHA2") {
    return { type: "robot", role, commonName: "robot", dialect: "space", evidence: "role" };
  }
  return { type: "unknown", role, commonName: null, dialect: null, evidence: "unrecognized" };
}

function baseDevice(overrides: BaseDeviceOverrides = {}): EndpointListEntry {
  const id = overrides.id ?? "SERIAL-A";
  const role = "role" in overrides ? (overrides.role ?? null) : "NEZHA2";
  const port = "port" in overrides ? (overrides.port ?? null) : "/dev/cu.usbmodemA";
  const entry: EndpointListEntry = {
    endpointId: `usb-${id}`,
    transport: "usb",
    resourceKey: `usb-${id}`,
    classification: classificationFor(role),
    name: "name" in overrides ? (overrides.name ?? null) : "zeguz",
    role,
    sessionOpen: overrides.linkOpen ?? true,
    usb: {
      serialNumber: overrides.serialNumber ?? "SERIAL-A-FULL",
      displaySerial: overrides.displaySerial ?? "0002",
      port,
    },
  };
  if (overrides.nameError) {
    entry.nameError = overrides.nameError;
  }
  if (overrides.linkError) {
    entry.sessionError = overrides.linkError;
  }
  return entry;
}

describe("EndpointsList", () => {
  it("renders a normal device row with name, role, port, and device id", () => {
    const el = mount(withRouter(<EndpointsList status="open" devices={[baseDevice()]} />));

    const text = el.textContent ?? "";
    expect(text).toContain("zeguz");
    expect(text).toContain("NEZHA2");
    expect(text).toContain("/dev/cu.usbmodemA");
    expect(text).toContain("0002");
  });

  it("flags a device that failed SWD naming as unnamed/error, not omitted", () => {
    const el = mount(
      withRouter(
        <EndpointsList
          status="open"
          devices={[
            baseDevice({
              id: "SERIAL-B",
              name: null,
              role: null,
              nameError: { reason: "swd-attach-failed", message: "could not attach over SWD" },
            }),
          ]}
        />,
      ),
    );

    const text = el.textContent ?? "";
    expect(text).toContain("Unnamed device");
    expect(text).toContain("could not attach over SWD");
    expect(el.querySelector('[data-testid="device-usb-SERIAL-B"]')).not.toBeNull();
  });

  it("shows a device that never replied to HELLO as unresponsive, not assigned a role", () => {
    const el = mount(
      withRouter(
        <EndpointsList
          status="open"
          devices={[
            baseDevice({
              id: "SERIAL-C",
              role: null,
              linkOpen: false,
              linkError: "HELLO reply timed out after 2000ms",
            }),
          ]}
        />,
      ),
    );

    const text = el.textContent ?? "";
    expect(text).toContain("Unresponsive");
    expect(text).toContain("HELLO reply timed out after 2000ms");
    expect(text).not.toContain("NEZHA2");
  });

  it("shows a device with no serial port as 'No serial port' in its port field", () => {
    const el = mount(
      withRouter(
        <EndpointsList status="open" devices={[baseDevice({ id: "SERIAL-D", port: null, linkOpen: false })]} />,
      ),
    );

    expect(el.textContent ?? "").toContain("No serial port");
  });

  it("shows a reconnecting banner without dropping the last-known device list", () => {
    const el = mount(withRouter(<EndpointsList status="closed" devices={[baseDevice()]} />));

    const text = el.textContent ?? "";
    expect(text).toContain("reconnecting");
    expect(text).toContain("zeguz");
  });

  it("shows 'no devices detected yet' when the list is empty", () => {
    const el = mount(withRouter(<EndpointsList status="open" devices={[]} />));

    expect(el.textContent ?? "").toContain("No devices detected yet");
  });

  it("renders each row as a real link to its device page", () => {
    const el = mount(withRouter(<EndpointsList status="open" devices={[baseDevice({ id: "SERIAL-LINK" })]} />));

    const link = el.querySelector('[data-testid="device-usb-SERIAL-LINK"]');
    expect(link?.tagName).toBe("A");
    expect(link?.getAttribute("href")).toBe("/d/usb-SERIAL-LINK");
  });
});

describe("FrontPage navigation", () => {
  it("navigates to /d/:endpointId when a device card is clicked", () => {
    let socket: FakeSocket | null = null;
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
          <AppRoutes />
        </WsProvider>,
      ),
    );

    act(() => {
      socket!.emitOpen();
    });
    act(() => {
      socket!.emitMessage({
        type: "endpoints",
        endpoints: [baseDevice({ id: "SERIAL-NAV", name: "kivon" })],
      });
    });

    const card = el.querySelector('[data-testid="device-usb-SERIAL-NAV"]');
    expect(card).not.toBeNull();
    act(() => {
      card!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(el.querySelector('[data-testid="location"]')?.textContent).toBe("/d/usb-SERIAL-NAV");
    // The default fixture classifies as "robot" (role "NEZHA2") -- ticket
    // 008 replaced ticket 007's "Device found: ..." placeholder with the
    // real per-type page content, so this now lands on `RobotPage`.
    expect(el.textContent).toContain("kivon");
  });
});
