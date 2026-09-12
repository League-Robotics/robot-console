// @vitest-environment jsdom
/**
 * RelayConnectControls.test.tsx — focused tests for the shared relay
 * connect controls (ticket 017-007): `relayStatusText`'s own status-copy
 * derivation, and both the `"card"` (`FrontPage.tsx`'s relay quick-
 * connect card) and `"page"` (`RelayPage.tsx`'s connect bar) variants'
 * rendering/wiring. `FrontPage.test.tsx`/`RelayPage.test.tsx` keep their
 * own integration-level assertions (mounted through the real page, over
 * a live `WsProvider`/`FakeSocket`); the duplicated status-copy
 * assertions those two files used to carry independently collapse to
 * the `relayStatusText` cases here.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SnapshotDevice, SnapshotLink, SnapshotRelay } from "@robot-console/host/src/wsMessages.js";
import { RelayConnectControls, relayStatusText } from "./RelayConnectControls";

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

const RELAY_LINK_ID = "usb-relay-1";

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

function relayDevice(overrides: Partial<Omit<SnapshotDevice, "links">> = {}): SnapshotDevice {
  return device(3, { name: "rly01", kind: "relay", links: [link(RELAY_LINK_ID)], ...overrides });
}

function childLinkFor(overrides: Partial<SnapshotLink> = {}): SnapshotLink {
  return link("radio-vevav-via-usb-relay-1", {
    transport: "radio",
    state: "connected",
    via: { relayLinkId: RELAY_LINK_ID, relayName: "rly01", channel: 55, group: 114, addressSource: "derived" },
    ...overrides,
  });
}

function childDevice(overrides: Partial<Omit<SnapshotDevice, "links">> = {}, linkOverrides: Partial<SnapshotLink> = {}): SnapshotDevice {
  return device(5, { name: "vevav", links: [childLinkFor(linkOverrides)], ...overrides });
}

describe("relayStatusText", () => {
  it("renders plain 'Connected to <name>' with channel/group when no relayName is given (FrontPage's card copy)", () => {
    const child = { device: childDevice(), link: childLinkFor() };
    expect(relayStatusText({ relayInfo: undefined, devices: [], relayLinkId: RELAY_LINK_ID }, child)).toEqual({
      kind: "connected",
      text: "Connected to vevav on channel 55, group 114",
    });
  });

  it("appends 'via <relayName>' when relayName is given (RelayPage's own copy)", () => {
    const child = { device: childDevice(), link: childLinkFor() };
    expect(relayStatusText({ relayInfo: undefined, devices: [], relayLinkId: RELAY_LINK_ID, relayName: "rly01" }, child)).toEqual({
      kind: "connected",
      text: "Connected to vevav via rly01 on channel 55, group 114",
    });
  });

  it("renders 'Connection to <name> lost' (with reason) when the child's link is not connected", () => {
    const child = { device: childDevice(), link: childLinkFor({ state: "unresponsive", reason: "no reply" }) };
    expect(relayStatusText({ relayInfo: undefined, devices: [], relayLinkId: RELAY_LINK_ID }, child).text).toBe(
      "Connection to vevav lost: no reply",
    );
    expect(relayStatusText({ relayInfo: undefined, devices: [], relayLinkId: RELAY_LINK_ID }, child).kind).toBe("lost");
  });

  it("renders the in-flight connecting/failed bridging state when no child is bridged", () => {
    const connecting: SnapshotRelay = { linkId: RELAY_LINK_ID, lease: "session", bridging: { state: "connecting", robotName: "GoPiv" } };
    expect(relayStatusText({ relayInfo: connecting, devices: [], relayLinkId: RELAY_LINK_ID }, undefined)).toEqual({
      kind: "connecting",
      text: "Connecting to GoPiv…",
    });

    const failed: SnapshotRelay = { linkId: RELAY_LINK_ID, lease: null, bridging: { state: "failed", robotName: "GoPiv", error: "GoPiv did not respond" } };
    expect(relayStatusText({ relayInfo: failed, devices: [], relayLinkId: RELAY_LINK_ID }, undefined)).toEqual({
      kind: "failed",
      text: "GoPiv did not respond",
    });
  });

  it("renders plain 'idle' with no relays[] entry, and 'idle · sweeping' variants otherwise", () => {
    expect(relayStatusText({ relayInfo: undefined, devices: [], relayLinkId: RELAY_LINK_ID }, undefined)).toEqual({ kind: "idle", text: "idle" });

    const sweeping: SnapshotRelay = { linkId: RELAY_LINK_ID, lease: "sweep" };
    expect(relayStatusText({ relayInfo: sweeping, devices: [], relayLinkId: RELAY_LINK_ID }, undefined).text).toBe("idle · sweeping");

    const withRate: SnapshotRelay = { linkId: RELAY_LINK_ID, lease: "sweep", sweep: { rate: "fast" } };
    expect(relayStatusText({ relayInfo: withRate, devices: [], relayLinkId: RELAY_LINK_ID }, undefined).text).toBe("idle · sweeping (fast)");

    const now = 1_000_000;
    const swept = device(6, {
      name: "vevav",
      lastChecked: now - 1000,
      links: [link("radio-x", { via: { relayLinkId: RELAY_LINK_ID, relayName: "rly01", channel: 1, group: 1, addressSource: "derived" } })],
    });
    expect(relayStatusText({ relayInfo: sweeping, devices: [swept], relayLinkId: RELAY_LINK_ID, now }, undefined).text).toBe(
      "idle · sweeping vevav",
    );
  });
});

describe("RelayConnectControls variant=card", () => {
  function renderCard(overrides: Partial<Parameters<typeof RelayConnectControls>[0]> = {}) {
    const onConnect = vi.fn();
    const onDisconnect = vi.fn();
    const el = mount(
      <RelayConnectControls
        variant="card"
        relay={relayDevice()}
        devices={[relayDevice()]}
        relays={[]}
        robotOptions={["gopiv", "vevav"]}
        onConnect={onConnect}
        onDisconnect={onDisconnect}
        sendable={true}
        {...overrides}
      />,
    );
    return { el, onConnect, onDisconnect };
  }

  it("renders the per-relay-id container and idle status by default", () => {
    const { el } = renderCard();
    expect(el.querySelector('[data-testid="relay-quick-connect-3"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="relay-quick-idle-3"]')?.textContent).toBe("idle");
  });

  it("shows Connect (not Switch) with no child, and Connect sends the picked name", () => {
    const { el, onConnect } = renderCard();
    const select = el.querySelector<HTMLSelectElement>('[data-testid="relay-quick-connect-select-3"]')!;
    act(() => {
      select.value = "vevav";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const button = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Connect")!;
    act(() => {
      button.click();
    });
    expect(onConnect).toHaveBeenCalledWith(RELAY_LINK_ID, "vevav");
  });

  it("shows Switch and a Disconnect button once a child is bridged", () => {
    const { el, onDisconnect } = renderCard({ devices: [relayDevice(), childDevice()] });
    expect(el.querySelector('[data-testid="relay-quick-connect-3"]')?.textContent).toContain("Switch");
    const disconnect = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Disconnect")!;
    act(() => {
      disconnect.click();
    });
    expect(onDisconnect).toHaveBeenCalledWith("radio-vevav-via-usb-relay-1");
  });

  it("disables Connect until a robot is picked", () => {
    const { el } = renderCard();
    const button = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Connect") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});

describe("RelayConnectControls variant=page", () => {
  function renderPage(overrides: Partial<Parameters<typeof RelayConnectControls>[0]> = {}) {
    const onConnect = vi.fn();
    const onDisconnect = vi.fn();
    const el = mount(
      <RelayConnectControls
        variant="page"
        relay={relayDevice()}
        devices={[relayDevice()]}
        relays={[]}
        robotOptions={["gopiv", "vevav"]}
        onConnect={onConnect}
        onDisconnect={onDisconnect}
        sendable={true}
        {...overrides}
      />,
    );
    return { el, onConnect, onDisconnect };
  }

  it("renders the connect bar before the idle status when not connected", () => {
    const { el } = renderPage();
    const idle = el.querySelector('[data-testid="relay-idle"]');
    const connect = el.querySelector('[data-testid="relay-connect"]');
    expect(idle?.textContent).toBe("idle");
    expect(connect).not.toBeNull();
    // Row precedes the status paragraph in document order.
    expect(connect!.compareDocumentPosition(idle!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders the connected status before the connect bar, with 'via <relay>'", () => {
    const { el } = renderPage({ devices: [relayDevice(), childDevice()] });
    const connected = el.querySelector('[data-testid="relay-connected"]');
    const connect = el.querySelector('[data-testid="relay-connect"]');
    expect(connected?.textContent).toBe("Connected to vevav via rly01 on channel 55, group 114");
    expect(connected!.compareDocumentPosition(connect!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(connect?.textContent).toBe("Switch");
  });

  it("renders 'relay-lost' when the child's link is not connected, keeping Disconnect available", () => {
    const { el } = renderPage({ devices: [relayDevice(), childDevice({}, { state: "unresponsive", reason: "no reply" })] });
    expect(el.querySelector('[data-testid="relay-lost"]')?.textContent).toBe("Connection to vevav lost: no reply");
    expect(el.querySelector('[data-testid="relay-disconnect"]')).not.toBeNull();
  });

  it("Connect sends exactly the picked name for the relay's own link id", () => {
    const { el, onConnect } = renderPage();
    const select = el.querySelector<HTMLSelectElement>('[data-testid="relay-robot-select"]')!;
    act(() => {
      select.value = "gopiv";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="relay-connect"]')!.click();
    });
    expect(onConnect).toHaveBeenCalledWith(RELAY_LINK_ID, "gopiv");
  });

  it("disables Connect when sendable is false", () => {
    const { el } = renderPage({ sendable: false, devices: [relayDevice(), device(6, { name: "gopiv" })], robotOptions: ["gopiv"] });
    const select = el.querySelector<HTMLSelectElement>('[data-testid="relay-robot-select"]')!;
    act(() => {
      select.value = "gopiv";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(el.querySelector<HTMLButtonElement>('[data-testid="relay-connect"]')!.disabled).toBe(true);
  });
});
