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

// ---------------------------------------------------------------------
// "Recent agent activity" -- sprint 019 ticket 006 (SUC-006/SUC-007)
// ---------------------------------------------------------------------

describe("DiagnosticsPanel: Recent agent activity", () => {
  it("renders the stable data-testid unconditionally, and the empty state (no stray list, no spinner) for a device no agent has ever touched", () => {
    const theLink = link();
    const el = mount(<DiagnosticsPanel device={device(theLink, { recentAgentActions: [] })} current={theLink} />);
    const section = el.querySelector('[data-testid="recent-agent-activity"]');
    expect(section).not.toBeNull();
    expect(el.querySelector('[data-testid="recent-agent-activity-empty"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="recent-agent-activity-list"]')).toBeNull();
    expect(el.querySelector('[role="status"], .spinner')).toBeNull();
  });

  it("renders the same empty state when recentAgentActions is absent entirely (a pre-ticket-006 snapshot literal)", () => {
    const theLink = link();
    const el = mount(<DiagnosticsPanel device={device(theLink)} current={theLink} />);
    expect(el.querySelector('[data-testid="recent-agent-activity"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="recent-agent-activity-empty"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="recent-agent-activity-list"]')).toBeNull();
  });

  it("renders kind/caller/summary/timestamp for each row, newest first as given, with no interactive element", () => {
    const theLink = link();
    const el = mount(
      <DiagnosticsPanel
        device={device(theLink, {
          recentAgentActions: [
            { kind: "flash", caller: "agent-smith", summary: "flash robot — failed: no USB device is currently enumerated", at: 2000 },
            { kind: "drive", caller: "agent-smith", summary: "WHEELS_V 40 40 — sent", at: 1000 },
          ],
        })}
        current={theLink}
      />,
    );
    const list = el.querySelector('[data-testid="recent-agent-activity-list"]');
    expect(list).not.toBeNull();
    expect(el.querySelector('[data-testid="recent-agent-activity-empty"]')).toBeNull();

    const rows = Array.from(el.querySelectorAll('[data-testid^="recent-agent-activity-row-"]'));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("flash");
    expect(rows[0]?.textContent).toContain("agent-smith");
    expect(rows[0]?.textContent).toContain("flash robot — failed: no USB device is currently enumerated");
    expect(rows[1]?.textContent).toContain("WHEELS_V 40 40 — sent");

    // Purely informational -- this ticket's own acceptance criterion: no
    // Approve/Deny, no acknowledge, nothing clickable anywhere in here.
    expect(list?.querySelectorAll("button, input, a[href]")).toHaveLength(0);
  });
});
