// @vitest-environment jsdom
/**
 * DevicePage.test.tsx — router-level tests for `/d/:linkId` (sprint 015
 * ticket 008; SUC-001's alternate flow, SUC-008), rewritten against the
 * `Snapshot` contract.
 *
 * Covers the `hasSnapshot` loading-vs-not-found distinction (a deep
 * link before the first snapshot must not flash "not connected" for a
 * device that may well be attached), the no-auto-redirect rule for a
 * link that disappears while its page is open, the per-`device.kind`
 * dispatch (no device at all -> `UnknownDevicePage`; `"relay"` ->
 * `RelayPage`; `"robot"` -> `RobotPage`), and this ticket's own
 * acceptance criterion that nothing here ever sends `session-open` on
 * mount or on any state transition -- the WiFi auto-open effect
 * (`:95-108` in the sprint-014-era file) is deleted, not adapted; the
 * reconciler (ticket 002's `planUserOpen`) owns that decision entirely
 * now.
 *
 * `RobotPage.tsx` is not migrated by this ticket (sprint 015 ticket
 * 009's own scope -- it still declares `{ endpoint: EndpointListEntry
 * }`, and its own subtree still imports hooks `WsProvider` no longer
 * exports), so it is mocked here with a thin stub: this file's job is
 * DevicePage's own dispatch logic, not RobotPage's internals (covered,
 * once migrated, by ticket 009's own suite).
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Snapshot, SnapshotDevice, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { AppRoutes } from "../router";
import { WsProvider } from "../ws/WsProvider";
import { FakeSocket } from "../testing/FakeSocket";
import { withRouter } from "../testing/renderWithRouter";

vi.mock("./RobotPage", () => ({
  RobotPage: ({ endpoint }: { endpoint: SnapshotDevice }) => (
    <section aria-label="Robot device" data-testid="robot-page-stub">
      {endpoint.name}
    </section>
  ),
}));

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

function link(id: string, overrides: Partial<SnapshotLink> = {}): SnapshotLink {
  return {
    id,
    transport: "usb",
    label: `USB · /dev/tty.usbmodem-${id}`,
    state: "connected",
    reason: null,
    since: 0,
    lastSeen: 0,
    nextRetryAt: null,
    capabilities: { open: false, close: true, flash: true, provisionWifi: true },
    ...overrides,
  };
}

function device(id: number, overrides: Partial<Omit<SnapshotDevice, "links">> & { links?: SnapshotLink[] } = {}): SnapshotDevice {
  const { links, ...rest } = overrides;
  return {
    id,
    name: `name-${id}`,
    kind: "robot",
    role: null,
    program: null,
    version: null,
    owned: true,
    radio: { channel: 1, group: 1, source: "derived" },
    lastSeen: 0,
    lastChecked: null,
    links: links ?? [link(`usb-${id}`)],
    ...rest,
  };
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    type: "snapshot",
    seq: 1,
    at: 0,
    devices: [],
    unassigned: [],
    relays: [],
    firmware: { relay: { configured: false }, robot: { configured: false } },
    wifi: { ssid: null, source: null },
    tasks: [],
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

  it("shows a distinct 'not connected' state once the snapshot arrives without this link", () => {
    // The way back to "/" is no longer rendered by DevicePage itself --
    // AppHeader is the single source of that control, covered by
    // AppHeader.test.tsx.
    const { el, socket } = mountAt("/d/usb-MISSING");
    act(() => {
      socket().emitOpen();
    });
    act(() => {
      socket().emitMessage(snapshot({ devices: [device(1)] }));
    });

    expect(el.textContent).not.toContain("Looking for this device");
    expect(el.textContent).toContain("isn't connected");
  });

  it("renders the matched link's owning device once the snapshot includes it", () => {
    const { el, socket } = mountAt("/d/usb-1");
    act(() => {
      socket().emitOpen();
    });
    act(() => {
      socket().emitMessage(snapshot({ devices: [device(1, { name: "kivon" })] }));
    });

    expect(el.textContent).toContain("kivon");
  });

  it("does not redirect when the open link disappears from a later snapshot", () => {
    const { el, socket } = mountAt("/d/usb-1");
    act(() => {
      socket().emitOpen();
    });
    act(() => {
      socket().emitMessage(snapshot({ devices: [device(1, { name: "kivon" })] }));
    });
    expect(el.textContent).toContain("kivon");

    act(() => {
      socket().emitMessage(snapshot({ devices: [] }));
    });

    expect(el.querySelector('[data-testid="location"]')?.textContent).toBe("/d/usb-1");
    expect(el.textContent).toContain("isn't connected");
  });
});

describe("DevicePage per-type dispatch", () => {
  it("dispatches a relay-kind device to RelayPage", () => {
    const { el, socket } = mountAt("/d/usb-1");
    act(() => {
      socket().emitOpen();
    });
    act(() => {
      socket().emitMessage(snapshot({ devices: [device(1, { kind: "relay", role: "RADIORELAY" })] }));
    });

    expect(el.querySelector('[aria-label="Relay device"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="relay-robot-select"]')).not.toBeNull();
  });

  it("dispatches a robot-kind device to RobotPage", () => {
    const { el, socket } = mountAt("/d/usb-1");
    act(() => {
      socket().emitOpen();
    });
    act(() => {
      socket().emitMessage(snapshot({ devices: [device(1, { kind: "robot", role: "NEZHA2" })] }));
    });

    expect(el.querySelector('[aria-label="Robot device"]')).not.toBeNull();
  });

  it("dispatches a link with no owning device (unassigned) to UnknownDevicePage", () => {
    const { el, socket } = mountAt("/d/usb-1");
    act(() => {
      socket().emitOpen();
    });
    act(() => {
      socket().emitMessage(snapshot({ unassigned: [link("usb-1")] }));
    });

    expect(el.querySelector('[aria-label="Unknown device"]')).not.toBeNull();
  });

  it("dispatches a calibration-program robot the same as any other robot -- RobotPage stays unaware of the distinction", () => {
    const { el, socket } = mountAt("/d/usb-1");
    act(() => {
      socket().emitOpen();
    });
    act(() => {
      socket().emitMessage(
        snapshot({ devices: [device(1, { kind: "robot", role: "NEZHA2", program: "calibration-0.20260907.2", version: "0.20260907.2" })] }),
      );
    });

    expect(el.querySelector('[aria-label="Robot device"]')).not.toBeNull();
  });
});

describe("DevicePage never sends session-open on its own (ticket 008)", () => {
  it("sends nothing at all on mount for a not-yet-open robot device", () => {
    const { socket } = mountAt("/d/usb-1");
    act(() => {
      socket().emitOpen();
    });
    act(() => {
      socket().emitMessage(snapshot({ devices: [device(1, { links: [link("usb-1", { state: "connectable" })] })] }));
    });

    expect(socket().sent).toEqual([]);
  });

  it("sends nothing at all on mount for an unassigned (not-yet-identified) link", () => {
    const { socket } = mountAt("/d/usb-1");
    act(() => {
      socket().emitOpen();
    });
    act(() => {
      socket().emitMessage(snapshot({ unassigned: [link("usb-1", { state: "connectable" })] }));
    });

    expect(socket().sent).toEqual([]);
  });

  it("sends nothing when a device's link transitions from connected to closed while its page is open", () => {
    const { socket } = mountAt("/d/usb-1");
    act(() => {
      socket().emitOpen();
    });
    act(() => {
      socket().emitMessage(snapshot({ devices: [device(1, { links: [link("usb-1", { state: "connected" })] })] }));
    });
    act(() => {
      socket().emitMessage(snapshot({ devices: [device(1, { links: [link("usb-1", { state: "closed_by_user" })] })] }));
    });

    expect(socket().sent).toEqual([]);
  });
});
