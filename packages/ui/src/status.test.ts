// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { SnapshotDevice, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { ageText, deviceStatus, linkStatus, statusTitle } from "./status";
import { DevicesList } from "./pages/FrontPage";
import { withRouter } from "./testing/renderWithRouter";

const NOW = 1_000_000;

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

const answering = (): NonNullable<SnapshotLink["session"]> => ({
  seq: 0,
  pending: 0,
  lastDone: null,
  lastDoneReason: null,
  robotStatus: null,
  functions: null,
  answeredAt: NOW,
});

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
    lastSeen: NOW,
    lastChecked: null,
    links: [link()],
    ...overrides,
  };
}

describe("linkStatus: one status rule for chips, bench icons and name pills", () => {
  it.each([
    [link({ state: "connected", session: answering() }), "linked"],
    [link({ state: "connected" }), "warn"],
    [link({ state: "unresponsive" }), "warn"],
    [link({ state: "failed" }), "error"],
    [link({ state: "stale" }), "absent"],
    [link({ state: "discovered" }), "idle"],
    [link({ state: "connectable" }), "idle"],
    [link({ state: "connecting" }), "idle"],
    [link({ state: "closed_by_user" }), "idle"],
  ] as const)("%#: maps to %s", (l, expected) => {
    expect(linkStatus(l, "robot", NOW)).toBe(expected);
  });

  it("treats a relay's own connected link (which never holds a session) as connected", () => {
    expect(linkStatus(link({ state: "connected" }), "relay", NOW)).toBe("linked");
  });

  it("titles every mark, so colour never carries the meaning alone", () => {
    expect(statusTitle("Radio", "linked")).toBe("Radio: connected");
    expect(statusTitle("USB", "idle", link({ state: "connecting" }))).toBe("USB: connecting");
  });
});

describe("deviceStatus", () => {
  it("is green when any current link answers, dashed when none is current", () => {
    expect(deviceStatus(device({ links: [link(), link({ id: "b", state: "connected", session: answering() })] }), NOW)).toBe("linked");
    expect(deviceStatus(device({ links: [link({ state: "stale" })] }), NOW)).toBe("absent");
    expect(deviceStatus(device({ links: [link({ state: "failed" })] }), NOW)).toBe("error");
    expect(deviceStatus(device({ links: [link({ state: "failed" }), link({ id: "b" })] }), NOW)).toBe("idle");
  });

  it("formats absent ages in minutes", () => {
    expect(ageText(NOW - 4 * 60_000 - 5_000, NOW)).toBe("4 min");
    expect(ageText(NOW - 10_000, NOW)).toBe("<1 min");
  });
});

describe("RobotCard markup", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  afterEach(() => {
    if (root) act(() => root!.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  it("renders a NamePill, mono meta, one round chip per transport with a title, and the round Open button", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const robot = device({
      program: "calibration-0.20261016.3",
      links: [link({ id: "usb-A", state: "connected", session: { ...answering(), answeredAt: Date.now() } })],
    });
    act(() => {
      root!.render(withRouter(createElement(DevicesList, { status: "open", devices: [robot], unassigned: [] })));
    });
    const card = container.querySelector('[data-testid="device-card-1"]')!;
    expect(card.classList.contains("lg-card")).toBe(true);
    expect(card.getAttribute("id")).toBe("device-1");
    const name = card.querySelector(".lg-name")!;
    expect(name.textContent).toBe("vevov");
    expect(name.getAttribute("data-status")).toBe("linked");
    expect(card.querySelector(".lg-badge")?.textContent).toBe("Calibration robot · 0.20261016.3");
    expect(card.querySelector(".lg-meta")?.textContent).toBe("robot · NEZHA2 · 0.20261016.3");
    const chips = Array.from(card.querySelectorAll(".lg-chips .lg-chip"));
    expect(chips.map((chip) => chip.getAttribute("title"))).toEqual(["USB: connected", expect.stringMatching(/^Radio: /)]);
    expect(chips[0]!.getAttribute("data-status")).toBe("linked");
    const open = card.querySelector(".lg-card__side .lg-round--open");
    expect(open?.getAttribute("href")).toBe("/d/usb-A");
    expect(open?.getAttribute("aria-label")).toBe("Open vevov");
  });
});
