// @vitest-environment jsdom
/**
 * AppHeader.test.tsx — component-level tests for the route-aware app
 * header, migrated to sprint 015's `Snapshot` contract (ticket 007).
 *
 * Covers what ticket 007 actually delivers: the back-to-devices link
 * across `/` and the `/d/:endpointId` states, and the `RadioAddressDialog`
 * call site now resolving its device via `useDeviceForLink` and passing
 * the `{deviceId, name, radio}` props that component has taken since
 * ticket 006.
 *
 * **Not covered here (dropped from the pre-ticket-007 suite, not
 * ported):** the Flash trigger's presence/gating and the in-dialog
 * reflash warning, and Set Wi-Fi's presence. `FlashDialog`/
 * `FlashControls`/`WifiCredentialsDialog` still speak the retired
 * per-endpoint contract (`EndpointListEntry` in their own prop types,
 * `useFirmwareStatus`'s old shape, `endpointId` on `flash-start`) and
 * are not in this ticket's file scope -- their own migration, and this
 * file's corresponding coverage, is ticket 008/009's. `AppHeader.tsx`'s
 * own doc comment records the same gap.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { Snapshot, SnapshotDevice } from "@robot-console/host/src/wsMessages.js";
import { AppHeader } from "./AppHeader";
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

function device(
  overrides: Partial<Omit<SnapshotDevice, "links">> & { links?: SnapshotDevice["links"] } = {},
): SnapshotDevice {
  const { links, ...rest } = overrides;
  return {
    id: 1,
    name: "zeguz",
    kind: "robot",
    role: null,
    program: null,
    version: null,
    owned: true,
    radio: { channel: 1, group: 1, source: "derived" },
    lastSeen: 0,
    lastChecked: null,
    links: links ?? [
      {
        id: "usb-SERIAL-A",
        transport: "usb",
        label: "USB · /dev/cu.usbmodemA",
        state: "connectable",
        reason: null,
        since: 0,
        lastSeen: 0,
        nextRetryAt: null,
        capabilities: { open: true, close: false, flash: true, provisionWifi: false },
      },
    ],
    ...rest,
  };
}

function snapshot(devices: SnapshotDevice[]): Snapshot {
  return {
    type: "snapshot",
    seq: 1,
    at: 0,
    devices,
    unassigned: [],
    relays: [],
    firmware: { relay: { configured: false }, robot: { configured: false } },
    wifi: { ssid: null, source: null },
    tasks: [],
  };
}

function mountAt(initialPath: string, options: { devices?: SnapshotDevice[] } = {}): { el: HTMLDivElement; socket: () => FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    withRouter(
      <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
        <AppHeader />
      </WsProvider>,
      { initialEntries: [initialPath] },
    ),
  );
  act(() => {
    socket!.emitOpen();
  });
  if (options.devices) {
    act(() => {
      socket!.emitMessage(snapshot(options.devices!));
    });
  }
  return { el, socket: () => socket! };
}

function backLink(el: HTMLDivElement): HTMLAnchorElement | null {
  return el.querySelector("a");
}

describe("AppHeader back-to-devices link", () => {
  it("renders no back link on /", () => {
    const { el } = mountAt("/");
    expect(backLink(el)).toBeNull();
  });

  it("renders exactly one back link, with an accessible name, in the loading state (!hasSnapshot)", () => {
    const { el } = mountAt("/d/usb-SERIAL-A");
    const links = el.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/");
    expect(links[0]?.getAttribute("aria-label")).toBe("Back to devices");
    expect(links[0]?.querySelector("svg")).not.toBeNull();
  });

  it("renders exactly one back link when no device owns the routed link id", () => {
    const { el } = mountAt("/d/usb-MISSING", { devices: [device()] });
    const links = el.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/");
  });

  it("renders exactly one back link on a relay device page", () => {
    const { el } = mountAt("/d/usb-RELAY-A", {
      devices: [
        device({
          id: 2,
          kind: "relay",
          role: "RADIOBRIDGE",
          links: [
            {
              id: "usb-RELAY-A",
              transport: "usb",
              label: "USB · relay",
              state: "connected",
              reason: null,
              since: 0,
              lastSeen: 0,
              nextRetryAt: null,
              capabilities: { open: false, close: true, flash: true, provisionWifi: false },
            },
          ],
        }),
      ],
    });
    const links = el.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/");
  });
});

describe("AppHeader Set Radio (sprint 015 ticket 007)", () => {
  it("shows no Set Radio trigger on / or in the loading state", () => {
    expect(mountAt("/").el.querySelector('[data-testid="radio-address-trigger"]')).toBeNull();
    expect(mountAt("/d/usb-SERIAL-A").el.querySelector('[data-testid="radio-address-trigger"]')).toBeNull();
  });

  it("shows no Set Radio trigger when no device owns the routed link id", () => {
    const { el } = mountAt("/d/usb-MISSING", { devices: [device()] });
    expect(el.querySelector('[data-testid="radio-address-trigger"]')).toBeNull();
  });

  it("shows Set Radio for a robot device page, passing the resolved deviceId/name/radio through to the dialog", () => {
    const { el } = mountAt("/d/usb-SERIAL-A", {
      devices: [device({ id: 42, name: "tigez", radio: { channel: 55, group: 114, source: "override" } })],
    });
    const trigger = el.querySelector<HTMLButtonElement>('[data-testid="radio-address-trigger"]');
    expect(trigger).not.toBeNull();
    act(() => {
      trigger!.click();
    });
    expect(el.querySelector("h2")?.textContent).toBe("Radio address for tigez");
    expect(el.querySelector<HTMLInputElement>('[data-testid="radio-channel"]')!.value).toBe("55");
    expect(el.querySelector<HTMLInputElement>('[data-testid="radio-group"]')!.value).toBe("114");
  });

  it("shows no Set Radio trigger for a relay device page", () => {
    const { el } = mountAt("/d/usb-RELAY-A", {
      devices: [
        device({
          id: 2,
          kind: "relay",
          links: [
            {
              id: "usb-RELAY-A",
              transport: "usb",
              label: "USB · relay",
              state: "connected",
              reason: null,
              since: 0,
              lastSeen: 0,
              nextRetryAt: null,
              capabilities: { open: false, close: true, flash: true, provisionWifi: false },
            },
          ],
        }),
      ],
    });
    expect(el.querySelector('[data-testid="radio-address-trigger"]')).toBeNull();
  });
});
