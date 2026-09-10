// @vitest-environment jsdom
/**
 * UnknownDevicePage.test.tsx — component-level tests for the unknown-
 * device page (SUC-002, SUC-003, SUC-004), trimmed by ticket 012-002 to
 * what's still page-specific now that `FlashControls.tsx` owns the
 * release/local-hex flash flow, its progress rendering, and its
 * `onFlashResult`/`onFlashLocalReady` subscriptions (see
 * `../components/FlashControls.test.tsx` for that coverage, migrated
 * from this file).
 *
 * What's left here: the page header, the endpoint's own `sessionError`
 * note (page-level, not part of the flash flow), that `FlashControls`
 * is actually wired up as a child (a thin smoke test -- the flash
 * behavior itself is exercised against the standalone component, not
 * duplicated here), and that `DeviceConsole` renders alongside it.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { EndpointListEntry, FirmwareKind, FirmwareAvailability } from "@robot-console/host/src/wsMessages.js";
import { UnknownDevicePage } from "./UnknownDevicePage";
import { AppHeader } from "../components/AppHeader";
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

function baseDevice(overrides: Partial<EndpointListEntry> = {}): EndpointListEntry {
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

function firmwareStatusFixture(): Record<FirmwareKind, FirmwareAvailability> {
  return {
    relay: {
      configured: true,
      repoUrl: "https://github.com/League-Robotics/microbit-radio-relay",
      tag: "v0.20260831.1",
      available: true,
    },
    robot: {
      configured: true,
      repoUrl: "https://github.com/League-Robotics/pxt-nezha-diffdrive",
      tag: "latest",
      available: true,
    },
  };
}

function mountUnknownPage(
  endpoint: EndpointListEntry,
  options: { firmwareStatus?: Record<FirmwareKind, FirmwareAvailability> } = {},
): { el: HTMLDivElement; socket: () => FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    withRouter(
      <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
        <UnknownDevicePage endpoint={endpoint} />
      </WsProvider>,
      { initialEntries: [`/d/${endpoint.endpointId}`] },
    ),
  );
  act(() => {
    socket!.emitOpen();
  });
  if (options.firmwareStatus) {
    act(() => {
      socket!.emitMessage({ type: "endpoints", endpoints: [endpoint], firmwareStatus: options.firmwareStatus });
    });
  }
  return { el, socket: () => socket! };
}

describe("UnknownDevicePage", () => {
  it("renders the endpoint's name as its header", () => {
    const { el } = mountUnknownPage(baseDevice({ name: "zeguz" }));
    expect(el.querySelector("h2")?.textContent).toBe("zeguz");
  });

  it("falls back to the endpointId as its header when the device has no name", () => {
    const { el } = mountUnknownPage(baseDevice({ name: null }));
    expect(el.querySelector("h2")?.textContent).toBe("usb-SERIAL-A");
  });

  it("shows a sessionError note when the session failed to link", () => {
    const { el } = mountUnknownPage(
      baseDevice({ sessionError: "HELLO reply timed out after 2000ms" }),
    );
    expect(el.textContent).toContain("Link attempt: HELLO reply timed out after 2000ms");
  });

  it("shows no sessionError note when the session has no error", () => {
    const { el } = mountUnknownPage(baseDevice());
    expect(el.textContent).not.toContain("Link attempt:");
  });

  it("mounts FlashDialog, offering a Flash trigger for a role-less device", () => {
    const { el } = mountUnknownPage(baseDevice({ role: null }), { firmwareStatus: firmwareStatusFixture() });
    const flashTrigger = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Flash");
    expect(flashTrigger).toBeDefined();
  });

  it("opening the Flash trigger reveals the flash flow for a role-less device", () => {
    const { el } = mountUnknownPage(baseDevice({ role: null }), { firmwareStatus: firmwareStatusFixture() });
    const flashTrigger = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Flash");
    act(() => {
      flashTrigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.textContent).toContain("Flash relay firmware");
    expect(el.textContent).toContain("Flash robot firmware");
  });

  it("shows no Flash trigger for an identified device (FlashDialog's own canBeFlashed gate)", () => {
    const { el } = mountUnknownPage(
      baseDevice({ role: "NEZHA2", sessionOpen: true }),
      { firmwareStatus: firmwareStatusFixture() },
    );
    const flashTrigger = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Flash");
    expect(flashTrigger).toBeUndefined();
  });

  it("renders DeviceConsole alongside the flash controls", () => {
    const { el } = mountUnknownPage(baseDevice());
    expect(el.querySelector('[aria-label="Console"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="console-send-input"]')).not.toBeNull();
  });
});

describe("UnknownDevicePage under AppHeader (ticket 012-004)", () => {
  // AppHeader owns the back-to-devices link and its own Flash trigger
  // (see AppHeader.test.tsx for the full behavior matrix); this is a
  // cheap per-page smoke test proving both actually show up on a real
  // unknown-device page's route, not just in AppHeader's own isolated
  // tests. An unknown device's own on-page Flash trigger (already
  // covered above) and AppHeader's Flash trigger coexist without
  // conflict -- each opens its own independent `FlashDialog` instance.
  it("shows a back-to-devices link and two independent, enabled Flash triggers alongside the unknown-device page", () => {
    const device = baseDevice({ role: null });
    let socket: FakeSocket | null = null;
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
          <AppHeader />
          <UnknownDevicePage endpoint={device} />
        </WsProvider>,
        { initialEntries: [`/d/${device.endpointId}`] },
      ),
    );
    act(() => {
      socket!.emitOpen();
    });
    act(() => {
      socket!.emitMessage({ type: "endpoints", endpoints: [device], firmwareStatus: firmwareStatusFixture() });
    });

    const backLink = el.querySelector("a");
    expect(backLink?.getAttribute("href")).toBe("/");
    const flashTriggers = Array.from(el.querySelectorAll("button")).filter((b) => b.textContent === "Flash");
    expect(flashTriggers).toHaveLength(2);
    expect(flashTriggers.every((b) => !b.disabled)).toBe(true);
  });
});
