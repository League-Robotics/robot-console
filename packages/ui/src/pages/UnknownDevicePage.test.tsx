// @vitest-environment jsdom
/**
 * UnknownDevicePage.test.tsx — component-level tests for the unknown-
 * device page (SUC-002, SUC-003, SUC-004), migrated sprint 015 ticket
 * 008 to the `Snapshot` contract: a bare `SnapshotLink` (no owning
 * device -- this is `Snapshot.unassigned`'s own page) in place of the
 * retired `EndpointListEntry`.
 *
 * What's covered here: the page header (the link's own `label`), the
 * link's own failure reason note (page-level, not part of the flash
 * flow), that `FlashControls` is actually wired up as a child (a thin
 * smoke test -- the flash behavior itself is exercised against the
 * standalone component, `../components/FlashControls.test.tsx`, not
 * duplicated here), and that `DeviceConsole` renders alongside it.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { FirmwareAvailability, FirmwareKind, Snapshot, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
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

function baseLink(overrides: Partial<SnapshotLink> = {}): SnapshotLink {
  return {
    id: "usb-SERIAL-A",
    transport: "usb",
    label: "zeguz",
    state: "connectable",
    reason: null,
    since: 0,
    lastSeen: 0,
    nextRetryAt: null,
    capabilities: { open: true, close: false, flash: true, provisionWifi: false },
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

function snapshotWith(link: SnapshotLink, firmware: Record<FirmwareKind, FirmwareAvailability>): Snapshot {
  return {
    type: "snapshot",
    seq: 1,
    at: 0,
    devices: [],
    unassigned: [link],
    relays: [],
    firmware,
    wifi: { ssid: null, source: null },
    tasks: [],
  };
}

function mountUnknownPage(
  link: SnapshotLink,
  options: { firmwareStatus?: Record<FirmwareKind, FirmwareAvailability> } = {},
): { el: HTMLDivElement; socket: () => FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    withRouter(
      <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
        <UnknownDevicePage link={link} />
      </WsProvider>,
      { initialEntries: [`/d/${link.id}`] },
    ),
  );
  act(() => {
    socket!.emitOpen();
  });
  const firmwareStatus = options.firmwareStatus;
  if (firmwareStatus) {
    act(() => {
      socket!.emitMessage(snapshotWith(link, firmwareStatus));
    });
  }
  return { el, socket: () => socket! };
}

describe("UnknownDevicePage", () => {
  it("renders the link's own label as its header", () => {
    const { el } = mountUnknownPage(baseLink({ label: "USB · /dev/cu.usbmodemA" }));
    expect(el.querySelector("h2")?.textContent).toBe("USB · /dev/cu.usbmodemA");
  });

  it("shows a failure-reason note when the link's own state is failed with a reason", () => {
    const { el } = mountUnknownPage(baseLink({ state: "failed", reason: "HELLO reply timed out after 2000ms" }));
    expect(el.textContent).toContain("Link attempt: HELLO reply timed out after 2000ms");
  });

  it("shows a failure-reason note for an unresponsive link too", () => {
    const { el } = mountUnknownPage(baseLink({ state: "unresponsive", reason: "no reply" }));
    expect(el.textContent).toContain("Link attempt: no reply");
  });

  it("shows no failure note for a connectable link with no reason", () => {
    const { el } = mountUnknownPage(baseLink());
    expect(el.textContent).not.toContain("Link attempt:");
  });

  it("mounts FlashDialog, offering a Flash trigger for a flashable link", () => {
    const { el } = mountUnknownPage(baseLink(), { firmwareStatus: firmwareStatusFixture() });
    const flashTrigger = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Flash");
    expect(flashTrigger).toBeDefined();
  });

  it("opening the Flash trigger reveals the flash flow for a flashable link", () => {
    const { el } = mountUnknownPage(baseLink(), { firmwareStatus: firmwareStatusFixture() });
    const flashTrigger = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Flash");
    act(() => {
      flashTrigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.textContent).toContain("Flash relay firmware");
    expect(el.textContent).toContain("Flash robot firmware");
  });

  it("shows no Flash trigger for a non-flashable link (FlashDialog's own canBeFlashed gate)", () => {
    const { el } = mountUnknownPage(
      baseLink({ capabilities: { open: false, close: true, flash: false, provisionWifi: true } }),
      { firmwareStatus: firmwareStatusFixture() },
    );
    const flashTrigger = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Flash");
    expect(flashTrigger).toBeUndefined();
  });

  it("renders DeviceConsole alongside the flash controls", () => {
    const { el } = mountUnknownPage(baseLink());
    expect(el.querySelector('[aria-label="Console"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="console-send-input"]')).not.toBeNull();
  });
});

describe("UnknownDevicePage under AppHeader (ticket 012-004)", () => {
  // AppHeader owns the back-to-devices link and its own Flash trigger
  // (see AppHeader.test.tsx for the full behavior matrix); this is a
  // cheap per-page smoke test proving both actually show up on a real
  // unknown-device page's route, not just in AppHeader's own isolated
  // tests. An unassigned link's own on-page Flash trigger (already
  // covered above) and AppHeader's Flash trigger coexist without
  // conflict -- each opens its own independent `FlashDialog` instance.
  it("shows a back-to-devices link and two independent, enabled Flash triggers alongside the unknown-device page", () => {
    const link = baseLink();
    let socket: FakeSocket | null = null;
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
          <AppHeader />
          <UnknownDevicePage link={link} />
        </WsProvider>,
        { initialEntries: [`/d/${link.id}`] },
      ),
    );
    act(() => {
      socket!.emitOpen();
    });
    act(() => {
      socket!.emitMessage(snapshotWith(link, firmwareStatusFixture()));
    });

    const backLink = el.querySelector("a");
    expect(backLink?.getAttribute("href")).toBe("/");
    const flashTriggers = Array.from(el.querySelectorAll("button")).filter((b) => b.textContent === "Flash");
    expect(flashTriggers).toHaveLength(2);
    expect(flashTriggers.every((b) => !b.disabled)).toBe(true);
  });
});
