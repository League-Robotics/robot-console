// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { Snapshot, SnapshotDevice, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { Sidebar } from "./Sidebar";
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
  container?.remove();
  container = null;
});

function link(overrides: Partial<SnapshotLink> = {}): SnapshotLink {
  return {
    id: "usb-A",
    transport: "usb",
    label: "USB · /dev/cu.usbmodemA",
    state: "connectable",
    reason: null,
    since: 0,
    lastSeen: 0,
    nextRetryAt: null,
    capabilities: { open: true, close: false, flash: true, provisionWifi: false },
    ...overrides,
  };
}

function device(overrides: Partial<SnapshotDevice> = {}): SnapshotDevice {
  return {
    id: 1,
    name: "vevov",
    kind: "robot",
    role: "NEZHA2",
    commonName: "robot",
    program: null,
    version: null,
    owned: true,
    radio: { channel: 1, group: 1, source: "derived" },
    lastSeen: Date.now(),
    lastChecked: null,
    links: [link()],
    ...overrides,
  };
}

function snapshot(devices: SnapshotDevice[], hostVersion?: string): Snapshot {
  return {
    type: "snapshot",
    seq: 1,
    at: 0,
    ...(hostVersion !== undefined ? { hostVersion } : {}),
    devices,
    unassigned: [],
    relays: [],
    firmware: { relay: { configured: false }, robot: { configured: false }, joystick: { configured: false } },
    wifi: { ssid: null, source: null },
    tasks: [],
  };
}

function mountSidebar(path: string, devices?: SnapshotDevice[], hostVersion?: string): HTMLDivElement {
  let socket: FakeSocket | null = null;
  const el = mount(
    withRouter(
      <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
        <Sidebar />
      </WsProvider>,
      { initialEntries: [path] },
    ),
  );
  act(() => {
    socket!.emitOpen();
  });
  if (devices) {
    act(() => {
      socket!.emitMessage(snapshot(devices, hostVersion));
    });
  }
  return el;
}

describe("Sidebar host version (stakeholder: version on the main page)", () => {
  // The version rides the snapshot over the WebSocket; a cross-origin
  // fetch under `npm run dev` would be blocked.
  it("shows the running host's version in the footer", () => {
    const el = mountSidebar("/", [], "0.20260919.12");
    expect(el.querySelector('[data-testid="host-version"]')?.textContent).toBe("0.20260919.12");
    expect(el.querySelector(".lg-rail__brand")?.textContent).toContain("Robot Console");
  });

  it("renders no placeholder when the host reports no version", () => {
    const el = mountSidebar("/", []);
    expect(el.querySelector('[data-testid="host-version"]')).toBeNull();
  });

  it("renders no placeholder before any snapshot has arrived", () => {
    const el = mountSidebar("/");
    expect(el.querySelector('[data-testid="host-version"]')).toBeNull();
  });
});

describe("Sidebar On the bench", () => {
  const answering = (): NonNullable<SnapshotLink["session"]> => ({
    seq: 0,
    pending: 0,
    lastDone: null,
    lastDoneReason: null,
    robotStatus: null,
    functions: null,
    answeredAt: Date.now(),
  });

  it("lists connected and recently seen devices with their state, how they are reached, and the age of absent ones", () => {
    const now = Date.now();
    const el = mountSidebar("/", [
      device({ id: 1, name: "vevov", links: [link({ id: "reg-1", transport: "mbregistry", state: "connected", session: answering() })] }),
      device({ id: 2, name: "zapig", links: [link({ id: "radio-2", transport: "radio", state: "connectable" })] }),
      device({ id: 3, name: "zetuv", lastSeen: now - 4 * 60_000, links: [link({ id: "usb-3", state: "stale" })] }),
      device({ id: 4, name: "oldie", lastSeen: now - 60 * 60_000, links: [link({ id: "usb-4", state: "stale" })] }),
      device({ id: 5, name: "rly01", kind: "relay", role: "RADIOBRIDGE", links: [link({ id: "usb-5", state: "connected" })] }),
    ]);
    const rows = Array.from(el.querySelectorAll<HTMLAnchorElement>(".lg-bench__row"));
    const byName = (name: string) => rows.find((row) => row.querySelector(".lg-bench__name")?.textContent === name);

    expect(el.querySelector('[data-testid="bench-count"]')?.textContent).toBe("4");
    expect(byName("oldie")).toBeUndefined();

    expect(byName("vevov")?.getAttribute("data-status")).toBe("linked");
    expect(byName("vevov")?.querySelector(".lg-bench__note")?.textContent).toBe("mbregistry");
    expect(byName("vevov")?.getAttribute("href")).toBe("/d/reg-1");
    expect(byName("vevov")?.querySelector('svg[data-icon="robot"]')).not.toBeNull();

    expect(byName("zapig")?.getAttribute("data-status")).toBe("idle");
    expect(byName("zapig")?.querySelector(".lg-bench__note")?.textContent).toBe("radio");
    expect(byName("zapig")?.getAttribute("href")).toBe("/#device-2");

    expect(byName("zetuv")?.getAttribute("data-status")).toBe("absent");
    expect(byName("zetuv")?.querySelector(".lg-bench__note")?.textContent).toBe("4 min");
    expect(byName("zetuv")?.getAttribute("title")).toContain("seen 4 min ago");

    expect(byName("rly01")?.getAttribute("data-status")).toBe("linked");
    expect(byName("rly01")?.querySelector('svg[data-icon="radio"]')).not.toBeNull();
  });

  it("marks the open device's row as the current page", () => {
    const el = mountSidebar("/d/usb-A", [device()]);
    expect(el.querySelector(".lg-bench__row")?.getAttribute("aria-current")).toBe("page");
  });

  it("links Browse only to sections the device list actually has", () => {
    const el = mountSidebar("/", [device({ links: [link({ state: "connectable" })] })]);
    const labels = Array.from(el.querySelectorAll(".lg-nav a")).map((a) => a.childNodes[1]?.textContent);
    expect(labels).toEqual(["All robots"]);
    expect(el.querySelector(".lg-nav a")?.getAttribute("aria-current")).toBe("page");
  });
});
