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

function relayDevice(overrides: Partial<Omit<SnapshotDevice, "links">> = {}): SnapshotDevice {
  return device(3, { name: "rly01", kind: "relay", links: [link(RELAY_LINK_ID)], ...overrides });
}

/** A session that has just answered -- ticket 018-010's "Linked"/
 * "connected" criterion (`isLinkAnswering`). `childLinkFor`'s own
 * default state is "connected", so it needs a fresh `answeredAt` by
 * default too, or every existing "bridged and connected" fixture in
 * this file would silently regress to the "Connecting…" kind. */
function answeredSession(): NonNullable<SnapshotLink["session"]> {
  return { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null, answeredAt: Date.now() };
}

function childLinkFor(overrides: Partial<SnapshotLink> = {}): SnapshotLink {
  const merged = link("radio-vevav-via-usb-relay-1", {
    transport: "radio",
    state: "connected",
    via: { relayLinkId: RELAY_LINK_ID, relayName: "rly01", channel: 55, group: 114, addressSource: "derived" },
    ...overrides,
  });
  // `exactOptionalPropertyTypes` forbids a call site writing `session:
  // undefined` explicitly (there is no way to say "omit this default" in
  // an object-literal override under that flag), so the "no session"
  // fixtures in this file simply omit `session` from their overrides --
  // only default it here, after merging, and only for the "connected"
  // shape the default represents (every "no session" fixture below
  // overrides `state` away from "connected").
  if (merged.state === "connected" && merged.session === undefined) {
    merged.session = answeredSession();
  }
  return merged;
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

  it("renders 'Connection to <name> lost' (with reason) when the child's link is not connected and has no session", () => {
    const child = { device: childDevice(), link: childLinkFor({ state: "unresponsive", reason: "no reply" }) };
    expect(relayStatusText({ relayInfo: undefined, devices: [], relayLinkId: RELAY_LINK_ID }, child).text).toBe(
      "Connection to vevav lost: no reply",
    );
    expect(relayStatusText({ relayInfo: undefined, devices: [], relayLinkId: RELAY_LINK_ID }, child).kind).toBe("lost");
  });

  // Ticket 018-010 bench defects (`torture`/`vevav`): a raw
  // `relayBridger:`-prefixed message naming an internal candidate id (
  // which can even name a *different* robot than the one the link
  // legitimately belongs to), and a raw Node `Error: No such file or
  // directory…`, both used to be interpolated into "Connection to
  // `<name>` lost" verbatim. Both must now route through
  // `deviceDisplay.ts`'s `plainFailureReason`, keyed by the child link's
  // own transport.
  it("cleans a raw relayBridger/candidate-id reason to plain, transport-aware words -- never showing raw ids", () => {
    const reason = 'relayBridger: candidate "radio-tigez-via-mbrelay-torture" produced no banner within the identify budget';
    const child = { device: childDevice({ name: "gopiv" }), link: childLinkFor({ state: "failed", reason }) };
    const text = relayStatusText({ relayInfo: undefined, devices: [], relayLinkId: RELAY_LINK_ID }, child).text;
    expect(text).toBe("Connection to gopiv lost: no radio reply — is the robot on and in range?");
    expect(text).not.toContain("tigez");
    expect(text).not.toContain("relayBridger");
    expect(text).not.toContain('"');
  });

  it("cleans a raw Node system error the same way, instead of showing it verbatim", () => {
    const child = {
      device: childDevice(),
      link: childLinkFor({ state: "failed", reason: "Error: No such file or directory, open '/dev/tty.usbmodem-relay-1'" }),
    };
    expect(relayStatusText({ relayInfo: undefined, devices: [], relayLinkId: RELAY_LINK_ID }, child).text).toBe(
      "Connection to vevav lost: no radio reply — is the robot on and in range?",
    );
  });

  // Ticket 018-010: "Connected to <name>" requires the session to have
  // actually answered (`isLinkAnswering`), not merely `state ===
  // "connected"` -- a session that exists but has never answered reads
  // "Connecting to <name>…" instead (still true, not yet proven).
  it("renders 'Connecting to <name>…' for a child whose session exists but has never answered", () => {
    const child = { device: childDevice(), link: childLinkFor({ session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null } }) };
    expect(relayStatusText({ relayInfo: undefined, devices: [], relayLinkId: RELAY_LINK_ID }, child)).toEqual({
      kind: "connecting",
      text: "Connecting to vevav…",
    });
  });

  it("renders 'Connecting to <name>…' for a child link still in the connecting state", () => {
    const child = { device: childDevice(), link: childLinkFor({ state: "connecting" }) };
    expect(relayStatusText({ relayInfo: undefined, devices: [], relayLinkId: RELAY_LINK_ID }, child)).toEqual({
      kind: "connecting",
      text: "Connecting to vevav…",
    });
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

  // Ticket 018-010 bench defects (`torture`/`vevav`): Switch/Disconnect
  // were shown "as if bridging" for a persisted child link that was
  // never actually bridged (no session ever opened for it) -- a stale
  // `failed` row left over from a candidate that never got past
  // identify. Only a plain Connect should show.
  it("shows plain Connect (never Switch/Disconnect) for a child with no real bridge session", () => {
    const { el } = renderCard({
      devices: [relayDevice(), childDevice({}, { state: "failed", reason: "no reply" })],
    });
    const container = el.querySelector('[data-testid="relay-quick-connect-3"]')!;
    expect(container.textContent).not.toContain("Switch");
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Disconnect")).toBe(false);
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Connect")).toBe(true);
  });

  // `connect/harvester.ts` keeps a session row open while a link is
  // merely `unresponsive` (not yet reaped) -- `RelayPage.tsx`'s own
  // design intent is that Disconnect stays offered in exactly that case
  // "so the student can retry or clean up", which this fixture (session
  // present, state unresponsive) exercises directly.
  it("still shows Switch/Disconnect for a child that is unresponsive but whose session is kept", () => {
    const { el } = renderCard({
      devices: [relayDevice(), childDevice({}, { state: "unresponsive", reason: "no reply", session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null } })],
    });
    const container = el.querySelector('[data-testid="relay-quick-connect-3"]')!;
    expect(container.textContent).toContain("Switch");
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Disconnect")).toBe(true);
  });

  it("disables Connect until a robot is picked", () => {
    const { el } = renderCard();
    const button = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Connect") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  // Ticket 017-010 (team-lead bench evidence, 2026-09-13): "the same
  // robot appears twice" -- the card variant renders its own inline
  // `<select>` (not `RobotSelect`), so it needs its own defensive
  // de-dupe of `robotOptions` for a name currently shared by two device
  // rows (an unmerged known-robots.json placeholder plus its real row).
  it("de-duplicates a repeated name in robotOptions", () => {
    const { el } = renderCard({ robotOptions: ["gopiv", "tovez", "tovez", "vevav"] });
    const select = el.querySelector<HTMLSelectElement>('[data-testid="relay-quick-connect-select-3"]')!;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(["", "gopiv", "tovez", "vevav"]);
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

  // `connect/harvester.ts` keeps a session row open while a link is
  // merely `unresponsive` (not yet reaped) -- `RelayPage.tsx`'s own
  // design intent is that Disconnect stays offered in exactly that
  // case, "so the student can retry or clean up" (ticket 018-010's
  // `hasBridgeSession`).
  it("renders 'relay-lost' when the child's link is unresponsive but its session is kept, keeping Disconnect available", () => {
    const { el } = renderPage({
      devices: [
        relayDevice(),
        childDevice(
          {},
          { state: "unresponsive", reason: "no reply", session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null } },
        ),
      ],
    });
    expect(el.querySelector('[data-testid="relay-lost"]')?.textContent).toBe("Connection to vevav lost: no reply");
    expect(el.querySelector('[data-testid="relay-disconnect"]')).not.toBeNull();
  });

  // The no-session counterpart: a persisted `failed`/stale child link
  // that never got a real bridge session must NOT offer Disconnect --
  // the `torture`/`vevav` bench defect ("shown with Switch/Disconnect as
  // if bridging").
  it("renders 'relay-lost' with only Connect (no Switch/Disconnect) when the child link never had a session", () => {
    // `since` recent (ticket 018-010's own `currentRelayChild` recency
    // gate -- see that function's own doc comment): a session-less
    // dropped child only counts as "the" child worth showing lost status
    // for when it dropped recently; this test is about the
    // Switch/Disconnect gating, not about staleness, so it pins `since`
    // to just now.
    const { el } = renderPage({
      devices: [relayDevice(), childDevice({}, { state: "unresponsive", reason: "no reply", since: Date.now() - 1000 })],
    });
    expect(el.querySelector('[data-testid="relay-lost"]')?.textContent).toBe("Connection to vevav lost: no reply");
    expect(el.querySelector('[data-testid="relay-disconnect"]')).toBeNull();
    expect(el.querySelector('[data-testid="relay-connect"]')?.textContent).toBe("Connect");
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
