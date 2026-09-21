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
 * `RobotPage.tsx` is mocked here with a thin stub regardless of its own
 * migration state (sprint 015 ticket 009): this file's job is
 * `DevicePage`'s own dispatch logic, not `RobotPage`'s internals
 * (covered by ticket 009's own suite, `RobotPage.test.tsx`).
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useNavigate } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Snapshot, SnapshotDevice, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { AppRoutes } from "../router";
import { WsProvider } from "../ws/WsProvider";
import { FakeSocket } from "../testing/FakeSocket";
import { withRouter } from "../testing/renderWithRouter";
import { createFakePopupWindow } from "../testing/FakePopupWindow";
import { openPopupWindow } from "../lib/popupWindow";

vi.mock("./RobotPage", () => ({
  RobotPage: ({ device }: { device: SnapshotDevice }) => (
    <section aria-label="Robot device" data-testid="robot-page-stub">
      {device.name}
    </section>
  ),
}));

/**
 * Sprint 022 ticket 006: `lib/popupWindow.ts` is mocked wholesale, same
 * as `ConsoleDock.test.tsx`/`PopupConsoleWindow.test.tsx` -- jsdom has
 * no real `window.open`, so `openPopupWindow` becomes a `vi.fn()`
 * pointed at a fresh `createFakePopupWindow()` fake per test.
 */
vi.mock("../lib/popupWindow", () => ({
  openPopupWindow: vi.fn(),
}));

/**
 * Test-only navigation harness for the two ticket-006 transitions that
 * aren't reachable by clicking a real in-app link from a deep-linked
 * device page: switching directly to a different routed device, and
 * returning to the device list. `AppHeader`'s own back link already
 * covers "navigate to `/`" for every other suite in this file's
 * neighborhood, but pulling in the full header here would couple these
 * tests to header markup unrelated to what they're checking; a bare
 * `useNavigate()` pair of buttons is the smaller, more direct fixture.
 */
function TestNavButtons() {
  const navigate = useNavigate();
  return (
    <div>
      <button type="button" data-testid="goto-device-2" onClick={() => navigate("/d/usb-2")}>
        Go to device 2
      </button>
      <button type="button" data-testid="goto-front" onClick={() => navigate("/")}>
        Go to front page
      </button>
    </div>
  );
}

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
  // `ConsoleDock`'s `useDockPersistence` (sprint 022 ticket 003) writes
  // to a single fixed `localStorage` key -- clear it between tests so a
  // later test never inherits an earlier one's toggled-open choice.
  window.localStorage.clear();
  vi.mocked(openPopupWindow).mockReset();
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
    commonName: null,
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
    firmware: { relay: { configured: false }, robot: { configured: false }, joystick: { configured: false } },
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

/** Same as {@link mountAt}, plus {@link TestNavButtons} mounted
 * alongside `AppRoutes` so a test can drive the two ticket-006
 * transitions that aren't reachable by clicking a real card/link from a
 * deep-linked device page. */
function mountAtWithNav(initialPath: string): { el: HTMLDivElement; socket: () => FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    withRouter(
      <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
        <TestNavButtons />
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

describe("DevicePage mounts ConsoleDock (sprint 022 ticket 002)", () => {
  it("mounts the dock alongside RobotPage for a robot-kind device", () => {
    const { el, socket } = mountAt("/d/usb-1");
    act(() => {
      socket().emitOpen();
    });
    act(() => {
      socket().emitMessage(snapshot({ devices: [device(1, { kind: "robot", role: "NEZHA2" })] }));
    });

    expect(el.querySelector('[aria-label="Robot device"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="console-dock"]')).not.toBeNull();
  });

  it("mounts the dock alongside RelayPage for a relay-kind device", () => {
    const { el, socket } = mountAt("/d/usb-1");
    act(() => {
      socket().emitOpen();
    });
    act(() => {
      socket().emitMessage(snapshot({ devices: [device(1, { kind: "relay", role: "RADIORELAY" })] }));
    });

    expect(el.querySelector('[aria-label="Relay device"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="console-dock"]')).not.toBeNull();
  });

  it("mounts the dock alongside UnknownDevicePage for a link with no owning device", () => {
    const { el, socket } = mountAt("/d/usb-1");
    act(() => {
      socket().emitOpen();
    });
    act(() => {
      socket().emitMessage(snapshot({ unassigned: [link("usb-1")] }));
    });

    expect(el.querySelector('[aria-label="Unknown device"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="console-dock"]')).not.toBeNull();
  });

  it("does not mount the dock while the device isn't connected or the snapshot hasn't arrived", () => {
    const { el, socket } = mountAt("/d/usb-MISSING");
    act(() => {
      socket().emitOpen();
    });

    expect(el.querySelector('[data-testid="console-dock"]')).toBeNull();

    act(() => {
      socket().emitMessage(snapshot({ devices: [device(1)] }));
    });
    expect(el.querySelector('[data-testid="console-dock"]')).toBeNull();
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

describe("DevicePage route-driven dock/popup lifecycle (sprint 022 ticket 006)", () => {
  // `RobotPage` is mocked in this file (top of file) with a thin stub
  // that never itself calls `onActiveTargetChange` -- these tests don't
  // need it to: for a plain (non-relay) device, `DevicePage`'s own
  // route-derived `routeTarget` fallback already tracks the routed
  // `link`/`device` on every render (see `DevicePage.tsx`'s own doc
  // comment, "Sprint 022 ticket 006"), so switching devices retargets
  // `ConsoleDock`/`PopupConsoleWindow` correctly even with `activeTarget`
  // itself staying `null` throughout. The bridging-specific half of this
  // mechanism (a child's report genuinely overriding the route) is
  // `RelayPage.test.tsx`'s job, not this file's -- that is the one case
  // where a report actually changes the outcome instead of just
  // confirming a default that was already correct.

  it("retargets an open popup's content in place when switching to a different routed device, without reopening it", () => {
    const fakePopup = createFakePopupWindow();
    vi.mocked(openPopupWindow).mockReturnValue(fakePopup as unknown as Window);

    const { el, socket } = mountAtWithNav("/d/usb-1");
    act(() => {
      socket().emitOpen();
    });
    act(() => {
      socket().emitMessage(
        snapshot({ devices: [device(1, { kind: "robot", role: "NEZHA2" }), device(2, { kind: "robot", role: "NEZHA2" })] }),
      );
    });

    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="console-dock-popout"]')!.click();
    });
    expect(openPopupWindow).toHaveBeenCalledTimes(1);
    expect(fakePopup.document.title).toBe("Debug Console — name-1");

    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="goto-device-2"]')!.click();
    });

    // Same `Window` object -- `openPopupWindow` is never called a second
    // time -- but the portaled content (here, just the title effect) has
    // moved on to the newly routed device.
    expect(openPopupWindow).toHaveBeenCalledTimes(1);
    expect(fakePopup.closed).toBe(false);
    expect(fakePopup.document.title).toBe("Debug Console — name-2");
  });

  it("closes an open popup and unmounts the dock entirely when navigating to /", () => {
    const fakePopup = createFakePopupWindow();
    vi.mocked(openPopupWindow).mockReturnValue(fakePopup as unknown as Window);

    const { el, socket } = mountAtWithNav("/d/usb-1");
    act(() => {
      socket().emitOpen();
    });
    act(() => {
      socket().emitMessage(snapshot({ devices: [device(1, { kind: "robot", role: "NEZHA2" })] }));
    });

    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="console-dock-popout"]')!.click();
    });
    expect(fakePopup.closed).toBe(false);

    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="goto-front"]')!.click();
    });

    // The popup is a genuinely separate browser window -- it does not
    // close itself just because the React tree that portaled into it
    // unmounted; `ConsoleDock`'s own explicit unmount effect (ticket
    // 006) is what closes it here.
    expect(fakePopup.closed).toBe(true);
    expect(el.querySelector('[data-testid="console-dock"]')).toBeNull();
    expect(el.querySelector('[data-testid="location"]')?.textContent).toBe("/");
  });

  it("does not close or reopen the popup across a route change that keeps the same device page mounted", () => {
    // A sibling check to the retarget test above: the popup itself must
    // survive the transition (never briefly `closed`) even though its
    // content updates -- ticket 006's own acceptance criterion is
    // "retargets... rather than closing it," not merely "ends up
    // showing the right thing eventually."
    const fakePopup = createFakePopupWindow();
    vi.mocked(openPopupWindow).mockReturnValue(fakePopup as unknown as Window);

    const { el, socket } = mountAtWithNav("/d/usb-1");
    act(() => {
      socket().emitOpen();
    });
    act(() => {
      socket().emitMessage(
        snapshot({ devices: [device(1, { kind: "robot", role: "NEZHA2" }), device(2, { kind: "robot", role: "NEZHA2" })] }),
      );
    });
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="console-dock-popout"]')!.click();
    });

    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="goto-device-2"]')!.click();
    });

    expect(fakePopup.closed).toBe(false);
    expect(el.querySelector('[data-testid="popup-console-window"]')).toBeNull(); // portaled into the fake, not `el`
  });
});
