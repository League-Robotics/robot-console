// @vitest-environment jsdom
/**
 * DiagnosticsPanel.test.tsx — component tests for the Diagnostics tab's
 * fact list (ticket 018-017): pins the "Library version" fact
 * (`device.version`, the pxt-nezha-diffdrive library version bundled
 * into whatever program is running) now that the front-page card's
 * identity line (`roleDisplay`) no longer shows it as "the" version --
 * this is where it moved to instead.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { SnapshotDevice, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { DiagnosticsPanel } from "./DiagnosticsPanel";

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

function link(overrides: Partial<SnapshotLink> = {}): SnapshotLink {
  return {
    id: "usb-A",
    transport: "usb",
    label: "USB · /dev/cu.usbmodemA",
    state: "connected",
    reason: null,
    since: 0,
    lastSeen: 0,
    nextRetryAt: null,
    capabilities: { open: false, close: true, flash: true, provisionWifi: true },
    ...overrides,
  };
}

function device(theLink: SnapshotLink, overrides: Partial<Omit<SnapshotDevice, "links">> = {}): SnapshotDevice {
  return {
    id: 1,
    name: "gopiv",
    kind: "robot",
    role: "NEZHA2",
    commonName: "robot",
    program: "calibration-0.20260913.1",
    version: "1.20260912.8",
    owned: true,
    radio: { channel: 1, group: 1, source: "derived" },
    lastSeen: 0,
    lastChecked: null,
    links: [theLink],
    ...overrides,
  };
}

function fact(el: HTMLDivElement, label: string): string | undefined {
  const dt = Array.from(el.querySelectorAll(".diagnostics-facts dt")).find((node) => node.textContent === label);
  return (dt?.nextElementSibling as HTMLElement | null)?.textContent ?? undefined;
}

describe("DiagnosticsPanel facts", () => {
  it("shows the library version (device.version) under a 'Library version' label", () => {
    const theLink = link();
    const el = mount(<DiagnosticsPanel device={device(theLink, { version: "1.20260912.8" })} current={theLink} />);
    expect(fact(el, "Library version")).toBe("1.20260912.8");
  });

  it("shows an em-dash when the library version isn't known yet", () => {
    const theLink = link();
    const el = mount(<DiagnosticsPanel device={device(theLink, { version: null })} current={theLink} />);
    expect(fact(el, "Library version")).toBe("—");
  });

  it("no longer labels this fact plain 'Version' (018-017: renamed so it reads distinctly from the release version on the card)", () => {
    const theLink = link();
    const el = mount(<DiagnosticsPanel device={device(theLink)} current={theLink} />);
    const labels = Array.from(el.querySelectorAll(".diagnostics-facts dt")).map((node) => node.textContent);
    expect(labels).not.toContain("Version");
    expect(labels).toContain("Library version");
  });
});
