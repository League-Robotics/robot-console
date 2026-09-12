// @vitest-environment jsdom
/**
 * FrontPage.test.tsx — component-level tests for the front page,
 * rewritten against sprint 015's `Snapshot` contract (ticket 007).
 *
 * Migrated from the pre-ticket-007 suite: connection banner, empty
 * state, per-link status text, calibration badge, linked pill, relay
 * quick-connect, and the "not seen recently" section (replacing
 * `RememberedRobotsSection`) all still have coverage here, against
 * `SnapshotDevice`/`SnapshotLink` fixtures instead of
 * `EndpointListEntry` ones. Not migrated: a real router click-through
 * into `/d/:linkId` (`DevicePage.tsx`/`router.tsx` still speak the
 * retired contract -- tickets 008/009) -- navigation is instead
 * verified directly against each `Link`'s `href`, which is what this
 * component actually owns. Also not migrated: the front-page Flash
 * trigger (`FlashDialog`/`FlashControls` still speak the retired
 * per-endpoint contract) -- see `FrontPage.tsx`'s own doc comment,
 * "Dropped this ticket, not carried over".
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { Snapshot, SnapshotDevice, SnapshotLink, SnapshotRelay } from "@robot-console/host/src/wsMessages.js";
import { DevicesList, FrontPage, RadioMigrationOffers, linkStatusText } from "./FrontPage";
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
  window.localStorage.clear();
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

describe("linkStatusText", () => {
  const now = 1_000_000;

  it("renders Linked/Connecting for the live states", () => {
    expect(linkStatusText(link("a", { state: "connected" }), now)).toBe("Linked");
    expect(linkStatusText(link("a", { state: "connecting" }), now)).toBe("Connecting");
  });

  it("renders Retrying in Ns when failed with a pending retry", () => {
    expect(linkStatusText(link("a", { state: "failed", nextRetryAt: now + 5000, reason: "timeout" }), now)).toBe("Retrying in 5s");
  });

  it("renders Unreachable: <reason> when failed with no pending retry", () => {
    expect(linkStatusText(link("a", { state: "failed", reason: "no reply" }), now)).toBe("Unreachable: no reply");
  });

  it("renders Unresponsive (with reason) for the unresponsive state", () => {
    expect(linkStatusText(link("a", { state: "unresponsive", reason: "HELLO timed out" }), now)).toBe("Unreachable: HELLO timed out");
    expect(linkStatusText(link("a", { state: "unresponsive" }), now)).toBe("Unresponsive");
  });

  it("renders Not seen since <date> for a stale link with a lastSeen", () => {
    const lastSeen = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(linkStatusText(link("a", { state: "stale", lastSeen }), now)).toContain("Not seen since");
  });

  it("renders Not linked for discovered/connectable/closed_by_user", () => {
    expect(linkStatusText(link("a", { state: "discovered" }), now)).toBe("Not linked");
    expect(linkStatusText(link("a", { state: "connectable" }), now)).toBe("Not linked");
    expect(linkStatusText(link("a", { state: "closed_by_user" }), now)).toBe("Not linked");
  });
});

describe("DevicesList", () => {
  it("renders a device card with name, role, and its one connection", () => {
    const el = mount(
      withRouter(<DevicesList status="open" devices={[device(1, { name: "zeguz", role: "NEZHA2" })]} unassigned={[]} />),
    );
    const text = el.textContent ?? "";
    expect(text).toContain("zeguz");
    expect(text).toContain("NEZHA2");
    expect(text).toContain("USB · /dev/tty.usbmodem-usb-1");
  });

  it("shows 'No role announced' when role is null", () => {
    const el = mount(withRouter(<DevicesList status="open" devices={[device(1, { role: null })]} unassigned={[]} />));
    expect(el.textContent ?? "").toContain("No role announced");
  });

  it("shows a connecting banner without dropping the last-known device list", () => {
    const el = mount(withRouter(<DevicesList status="connecting" devices={[device(1)]} unassigned={[]} />));
    const text = el.textContent ?? "";
    expect(text).toContain("Connecting to robot-console");
    expect(text).toContain("name-1");
  });

  it("shows a reconnecting banner without dropping the last-known device list", () => {
    const el = mount(withRouter(<DevicesList status="closed" devices={[device(1)]} unassigned={[]} />));
    const text = el.textContent ?? "";
    expect(text).toContain("reconnecting");
    expect(text).toContain("name-1");
  });

  it("shows 'no devices detected yet' when both devices and unassigned are empty", () => {
    const el = mount(withRouter(<DevicesList status="open" devices={[]} unassigned={[]} />));
    expect(el.textContent ?? "").toContain("No devices detected yet");
  });

  it("renders the open arrow as a real link to the device's primary link page", () => {
    const el = mount(withRouter(<DevicesList status="open" devices={[device(1)]} unassigned={[]} />));
    const openArrow = el.querySelector('[data-testid="device-open-1"]');
    expect(openArrow?.tagName).toBe("A");
    expect(openArrow?.getAttribute("href")).toBe("/d/usb-1");
  });

  it("shows a distinguishing calibration badge from device.program's calibration- prefix, with version", () => {
    const el = mount(
      withRouter(<DevicesList status="open" devices={[device(1, { program: "calibration-0.20260907.2", version: "0.20260907.2" })]} unassigned={[]} />),
    );
    const badge = el.querySelector('[data-testid="calibration-badge"]');
    expect(badge?.textContent).toBe("Calibration robot · 0.20260907.2");
  });

  it("falls back to a version-less calibration badge when version is null", () => {
    const el = mount(
      withRouter(<DevicesList status="open" devices={[device(1, { program: "calibration-x", version: null })]} unassigned={[]} />),
    );
    expect(el.querySelector('[data-testid="calibration-badge"]')?.textContent).toBe("Calibration robot");
  });

  it("shows no calibration badge for a plain program (regression)", () => {
    const el = mount(withRouter(<DevicesList status="open" devices={[device(1, { program: "diffdrive" })]} unassigned={[]} />));
    expect(el.querySelector('[data-testid="calibration-badge"]')).toBeNull();
  });

  it("shows the Linked pill only when some link is connected", () => {
    const linked = mount(withRouter(<DevicesList status="open" devices={[device(1, { links: [link("usb-1", { state: "connected" })] })]} unassigned={[]} />));
    expect(linked.querySelector(".device-linked-pill")).not.toBeNull();

    if (root) act(() => root!.unmount());
    if (container) container.remove();

    const notLinked = mount(withRouter(<DevicesList status="open" devices={[device(1, { links: [link("usb-1", { state: "connectable" })] })]} unassigned={[]} />));
    expect(notLinked.querySelector(".device-linked-pill")).toBeNull();
  });
});

describe("multi-link device (host already groups links under one device)", () => {
  function multiLinkDevice(): SnapshotDevice {
    return device(1, {
      name: "vevov",
      links: [
        link("usb-vevov", { state: "connected", session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null } }),
        link("wifi-vevov", { transport: "wifi", label: "WiFi · vevov.local:7654", state: "failed", reason: "could not reach vevov.local:7654" }),
      ],
    });
  }

  it("lists every link, with the primary (open-session) link's open arrow on the card and a small row arrow for the rest", () => {
    const el = mount(withRouter(<DevicesList status="open" devices={[multiLinkDevice()]} unassigned={[]} />));

    expect(el.querySelectorAll("h3.device-name")).toHaveLength(1);
    expect(el.querySelector('[data-testid="device-open-1"]')?.getAttribute("href")).toBe("/d/usb-vevov");

    const rows = el.querySelectorAll(".device-connections li");
    expect(rows).toHaveLength(2);
    const wifiRow = el.querySelector('[data-testid="device-link-wifi-vevov"]');
    expect(wifiRow?.textContent).toContain("WiFi · vevov.local:7654");
    expect(wifiRow?.textContent).toContain("Unreachable: could not reach vevov.local:7654");
    expect(el.querySelector('[data-testid="device-link-open-wifi-vevov"]')?.getAttribute("href")).toBe("/d/wifi-vevov");
    // The primary link gets no extra row arrow -- the card's own open
    // arrow already leads there.
    expect(el.querySelector('[data-testid="device-link-open-usb-vevov"]')).toBeNull();
    expect(el.querySelector('[data-testid="device-link-usb-vevov"]')?.textContent).toContain("Linked");
    expect(el.querySelectorAll("a a")).toHaveLength(0);
  });
});

describe("unassigned USB boards (acceptance: un-owned WiFi absent, unassigned present -> card renders)", () => {
  it("renders the unassigned board's card via DevicesList directly", () => {
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => new FakeSocket()}>
          <DevicesList status="open" devices={[]} unassigned={[link("usb-unknown-1", { state: "discovered", label: "USB · /dev/tty.usbmodem-unknown" })]} />
        </WsProvider>,
      ),
    );
    const card = el.querySelector('[data-testid="unassigned-card-usb-unknown-1"]');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain("Unidentified board");
    expect(card!.textContent).toContain("USB · /dev/tty.usbmodem-unknown");
    expect(el.querySelector('[data-testid="unassigned-open-usb-unknown-1"]')?.getAttribute("href")).toBe("/d/usb-unknown-1");
  });

  it("restores the Flash trigger on an unassigned board's card (sprint 015 ticket 008)", () => {
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => new FakeSocket()}>
          <DevicesList
            status="open"
            devices={[]}
            unassigned={[link("usb-unknown-1", { state: "discovered", label: "USB · /dev/tty.usbmodem-unknown" })]}
          />
        </WsProvider>,
      ),
    );
    const card = el.querySelector('[data-testid="unassigned-card-usb-unknown-1"]')!;
    const flashTrigger = Array.from(card.querySelectorAll("button")).find((b) => b.textContent === "Flash");
    expect(flashTrigger).toBeDefined();
  });

  it("offers no Flash trigger for an unassigned board whose link capabilities say flash is unavailable", () => {
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => new FakeSocket()}>
          <DevicesList
            status="open"
            devices={[]}
            unassigned={[
              link("usb-unknown-1", {
                state: "discovered",
                label: "USB · /dev/tty.usbmodem-unknown",
                capabilities: { open: true, close: false, flash: false, provisionWifi: false },
              }),
            ]}
          />
        </WsProvider>,
      ),
    );
    const card = el.querySelector('[data-testid="unassigned-card-usb-unknown-1"]')!;
    const flashTrigger = Array.from(card.querySelectorAll("button")).find((b) => b.textContent === "Flash");
    expect(flashTrigger).toBeUndefined();
  });

  // Ticket 011 (carried from 009's send-gating sweep): the Flash trigger
  // gates on `useSendable()` inside the shared `FlashDialog` component
  // (see that module's own doc comment) -- exercised here through
  // `FrontPage`'s unassigned-board card, one of its three call sites.
  it("disables the Flash trigger on an unassigned board's card once the socket closes", () => {
    let socket: FakeSocket | null = null;
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
          <DevicesList
            status="open"
            devices={[]}
            unassigned={[link("usb-unknown-1", { state: "discovered", label: "USB · /dev/tty.usbmodem-unknown" })]}
          />
        </WsProvider>,
      ),
    );
    act(() => {
      socket!.emitOpen();
    });
    const card = el.querySelector('[data-testid="unassigned-card-usb-unknown-1"]')!;
    const flashTrigger = Array.from(card.querySelectorAll("button")).find((b) => b.textContent === "Flash")!;
    expect(flashTrigger.disabled).toBe(false);

    act(() => {
      socket!.close();
    });
    expect(flashTrigger.disabled).toBe(true);
  });

  it("renders the unassigned board's card end-to-end through WsProvider + FrontPage, with no un-owned wifi device present", () => {
    let socket: FakeSocket | null = null;
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
          <FrontPage />
        </WsProvider>,
      ),
    );
    act(() => {
      socket!.emitOpen();
    });
    act(() => {
      // `devices` is empty -- an un-owned wifi device is never even
      // sent by a projection-compliant host, so this snapshot already
      // represents that case; `unassigned` carries the one USB board.
      socket!.emitMessage(
        snapshot({
          devices: [],
          unassigned: [link("usb-unknown-1", { state: "discovered" })],
        }),
      );
    });
    expect(el.querySelector('[data-testid="unassigned-card-usb-unknown-1"]')).not.toBeNull();
  });
});

describe("not seen recently (devices the host still knows about with zero current links)", () => {
  it("renders a not-seen-recently card with name, last-seen, and no Link for that card", () => {
    const lastSeen = Date.UTC(2026, 0, 1, 12, 34);
    const el = mount(
      withRouter(<DevicesList status="open" devices={[]} unassigned={[]} notSeenRecently={[device(2, { name: "wobin", links: [], lastSeen })]} />),
    );
    const text = el.textContent ?? "";
    expect(text).toContain("wobin");
    expect(text).toContain(new Date(lastSeen).toLocaleString());
    const card = el.querySelector('[data-testid="not-seen-device-2"]');
    expect(card).not.toBeNull();
    expect(card?.tagName).not.toBe("A");
    expect(card?.querySelector("a")).toBeNull();
  });

  it("renders no not-seen-recently section when the list is empty", () => {
    const el = mount(withRouter(<DevicesList status="open" devices={[device(1)]} unassigned={[]} notSeenRecently={[]} />));
    expect(el.querySelector(".remembered-robots")).toBeNull();
  });

  it("FrontPage splits devices with zero links into the not-seen-recently section and sends forget-device on Forget", () => {
    let socket: FakeSocket | null = null;
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
          <FrontPage />
        </WsProvider>,
      ),
    );
    act(() => {
      socket!.emitOpen();
    });
    act(() => {
      socket!.emitMessage(snapshot({ devices: [device(9, { name: "nuvek", links: [] })] }));
    });
    expect(el.querySelector('[data-testid="not-seen-device-9"]')).not.toBeNull();

    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="not-seen-forget-9"]')!.click();
    });
    expect(socket!.sent).toEqual([JSON.stringify({ type: "forget-device", deviceId: 9 })]);
  });

  it("the row disappears once the next snapshot omits the device (no optimistic local removal needed)", () => {
    let socket: FakeSocket | null = null;
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
          <FrontPage />
        </WsProvider>,
      ),
    );
    act(() => {
      socket!.emitOpen();
    });
    act(() => {
      socket!.emitMessage(snapshot({ devices: [device(9, { name: "nuvek", links: [] })] }));
    });
    expect(el.querySelector('[data-testid="not-seen-device-9"]')).not.toBeNull();

    act(() => {
      socket!.emitMessage(snapshot({ devices: [] }));
    });
    expect(el.querySelector('[data-testid="not-seen-device-9"]')).toBeNull();
  });
});

describe("relay quick-connect", () => {
  function relayDevice(overrides: Partial<Omit<SnapshotDevice, "links">> = {}): SnapshotDevice {
    return device(3, {
      name: "rly01",
      kind: "relay",
      role: "RADIOBRIDGE",
      links: [link("usb-relay-1", { state: "connected" })],
      ...overrides,
    });
  }

  it("carries a robot picker and Connect that reports {relayLinkId, name}", () => {
    const connects: Array<[string, string]> = [];
    const el = mount(
      withRouter(
        <DevicesList
          status="open"
          devices={[relayDevice()]}
          unassigned={[]}
          robotOptions={["gopiv", "vevav"]}
          onRelayConnect={(relayLinkId, name) => connects.push([relayLinkId, name])}
        />,
      ),
    );
    const select = el.querySelector<HTMLSelectElement>('[data-testid="relay-quick-connect-select-3"]');
    expect(select).not.toBeNull();
    expect(Array.from(select!.options).map((o) => o.textContent)).toEqual(["Choose a robot…", "gopiv", "vevav"]);

    act(() => {
      select!.value = "vevav";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const connect = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Connect");
    act(() => {
      connect!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(connects).toEqual([["usb-relay-1", "vevav"]]);
  });

  it("Connect is disabled until a robot is picked (no auto/no-pick request in the new contract)", () => {
    const el = mount(withRouter(<DevicesList status="open" devices={[relayDevice()]} unassigned={[]} robotOptions={["vevav"]} />));
    const connect = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Connect");
    expect(connect?.disabled).toBe(true);
  });

  it("with a child already bridged, shows Connected to <name> on channel/group and offers Switch/Disconnect", () => {
    const disconnects: string[] = [];
    const child = device(4, {
      name: "vevav",
      links: [
        link("usb-relay-1-via-vevav", {
          transport: "radio",
          state: "connected",
          via: { relayLinkId: "usb-relay-1", relayName: "rly01", channel: 55, group: 114, addressSource: "derived" },
        }),
      ],
    });
    const el = mount(
      withRouter(
        <DevicesList
          status="open"
          devices={[relayDevice(), child]}
          unassigned={[]}
          robotOptions={["vevav"]}
          onRelayDisconnect={(linkId) => disconnects.push(linkId)}
        />,
      ),
    );
    const quick = el.querySelector('[data-testid="relay-quick-connect-3"]');
    expect(quick?.textContent).toContain("Connected to vevav on channel 55, group 114");
    expect(quick?.querySelector<HTMLSelectElement>("select")?.value).toBe("vevav");

    const disconnect = Array.from(quick?.querySelectorAll("button") ?? []).find((b) => b.textContent === "Disconnect");
    act(() => {
      disconnect!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(disconnects).toEqual(["usb-relay-1-via-vevav"]);

    // The bridged robot is its own device-list card, listing the radio link.
    expect(el.querySelector('[data-testid="device-link-usb-relay-1-via-vevav"]')?.textContent).toContain(
      "via relay rly01",
    );
  });

  it("a child whose link has dropped shows 'Connection to <name> lost', not 'Connected to'", () => {
    const child = device(4, {
      name: "vevav",
      links: [
        link("usb-relay-1-via-vevav", {
          transport: "radio",
          state: "failed",
          reason: "no reply from vevav",
          via: { relayLinkId: "usb-relay-1", relayName: "rly01", channel: 55, group: 114, addressSource: "derived" },
        }),
      ],
    });
    const el = mount(withRouter(<DevicesList status="open" devices={[relayDevice(), child]} unassigned={[]} />));
    const quick = el.querySelector('[data-testid="relay-quick-connect-3"]');
    const lost = quick?.querySelector('[data-testid="relay-quick-lost-3"]');
    expect(lost).not.toBeNull();
    expect(lost?.textContent).toBe("Connection to vevav lost: no reply from vevav");
    const buttons = Array.from(quick?.querySelectorAll("button") ?? []).map((b) => b.textContent);
    expect(buttons).toContain("Switch");
    expect(buttons).toContain("Disconnect");
  });

  it("renders 'Connecting to <name>…' from relays[].bridging with no child link present yet", () => {
    const relays: SnapshotRelay[] = [{ linkId: "usb-relay-1", lease: null, bridging: { state: "connecting", robotName: "GoPiv" } }];
    const el = mount(withRouter(<DevicesList status="open" devices={[relayDevice()]} unassigned={[]} relays={relays} />));
    expect(el.querySelector('[data-testid="relay-quick-connecting-3"]')?.textContent).toBe("Connecting to GoPiv…");
  });

  it("renders the failure reason from relays[].bridging.error", () => {
    const relays: SnapshotRelay[] = [{ linkId: "usb-relay-1", lease: null, bridging: { state: "failed", robotName: "GoPiv", error: "GoPiv did not respond" } }];
    const el = mount(withRouter(<DevicesList status="open" devices={[relayDevice()]} unassigned={[]} relays={relays} />));
    expect(el.querySelector('[data-testid="relay-quick-failed-3"]')?.textContent).toBe("GoPiv did not respond");
  });

  it("FrontPage wires Connect to send exactly {type: 'session-open', relayLinkId, name}", () => {
    let socket: FakeSocket | null = null;
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
          <FrontPage />
        </WsProvider>,
      ),
    );
    act(() => {
      socket!.emitOpen();
    });
    act(() => {
      socket!.emitMessage(snapshot({ devices: [relayDevice(), device(5, { name: "vevav", kind: "robot" })] }));
    });

    const select = el.querySelector<HTMLSelectElement>('[data-testid="relay-quick-connect-select-3"]');
    act(() => {
      select!.value = "vevav";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const connect = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Connect");
    act(() => {
      connect!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(socket!.sent).toEqual([JSON.stringify({ type: "session-open", relayLinkId: "usb-relay-1", name: "vevav" })]);
  });

  // Ticket 011 (carried from 009's send-gating sweep): the quick-connect
  // Connect/Switch button gates on `useSendable()` the same way
  // `RelayPage.tsx`'s own Connect/Switch does.
  it("Connect disables once the socket closes, and no message is sent while disabled", () => {
    let socket: FakeSocket | null = null;
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
          <FrontPage />
        </WsProvider>,
      ),
    );
    act(() => {
      socket!.emitOpen();
    });
    act(() => {
      socket!.emitMessage(snapshot({ devices: [relayDevice(), device(5, { name: "vevav", kind: "robot" })] }));
    });

    const select = el.querySelector<HTMLSelectElement>('[data-testid="relay-quick-connect-select-3"]');
    act(() => {
      select!.value = "vevav";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const connect = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Connect")!;
    expect(connect.disabled).toBe(false);

    act(() => {
      socket!.close();
    });
    expect(connect.disabled).toBe(true);

    act(() => {
      connect.click();
    });
    expect(socket!.sent).toEqual([]);
  });

  it("FrontPage's robotOptions never include the relay device itself, only kind: robot devices", () => {
    let socket: FakeSocket | null = null;
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
          <FrontPage />
        </WsProvider>,
      ),
    );
    act(() => {
      socket!.emitOpen();
    });
    act(() => {
      socket!.emitMessage(snapshot({ devices: [relayDevice(), device(5, { name: "vevav", kind: "robot" })] }));
    });
    const select = el.querySelector<HTMLSelectElement>('[data-testid="relay-quick-connect-select-3"]');
    expect(Array.from(select!.options).map((o) => o.textContent)).toEqual(["Choose a robot…", "vevav"]);
  });
});

describe("RadioMigrationOffers (carried from ticket 006: leftover localStorage radio override)", () => {
  it("renders nothing when there is nothing to offer", () => {
    const el = mount(withRouter(<RadioMigrationOffers offers={[]} onResolve={() => {}} />));
    expect(el.querySelector(".radio-migration-offers")).toBeNull();
  });

  it("renders one offer per pending migration, and Apply/Dismiss both resolve it", () => {
    const resolved: Array<[number, boolean]> = [];
    const el = mount(
      withRouter(
        <RadioMigrationOffers
          offers={[{ deviceId: 7, name: "tigez", channel: 55, group: 114, storageKey: "robot-console:relay-address:tigez" }]}
          onResolve={(deviceId, apply) => resolved.push([deviceId, apply])}
        />,
      ),
    );
    const offer = el.querySelector('[data-testid="radio-migration-offer-7"]');
    expect(offer).not.toBeNull();
    expect(offer!.textContent).toContain("tigez");
    expect(offer!.textContent).toContain("channel 55, group 114");

    const buttons = Array.from(offer!.querySelectorAll("button"));
    act(() => {
      buttons[0]!.click();
    });
    expect(resolved).toEqual([[7, true]]);
  });

  it("end-to-end: a leftover localStorage key for a device in the snapshot is offered exactly once, applying sends set-radio-override and clears the key", () => {
    window.localStorage.setItem("robot-console:relay-address:tigez", JSON.stringify({ channel: 41, group: 3 }));
    let socket: FakeSocket | null = null;
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
          <FrontPage />
        </WsProvider>,
      ),
    );
    act(() => {
      socket!.emitOpen();
    });
    act(() => {
      socket!.emitMessage(snapshot({ devices: [device(9, { name: "tigez" })] }));
    });

    const offer = el.querySelector('[data-testid="radio-migration-offer-9"]');
    expect(offer).not.toBeNull();
    expect(offer!.textContent).toContain("channel 41, group 3");

    const applyButton = Array.from(offer!.querySelectorAll("button")).find((b) => b.textContent === "Apply");
    act(() => {
      applyButton!.click();
    });

    expect(socket!.sent).toEqual([JSON.stringify({ type: "set-radio-override", deviceId: 9, channel: 41, group: 3 })]);
    expect(window.localStorage.getItem("robot-console:relay-address:tigez")).toBeNull();
    expect(el.querySelector('[data-testid="radio-migration-offer-9"]')).toBeNull();
  });

  it("Dismiss clears the key without sending set-radio-override", () => {
    window.localStorage.setItem("robot-console:relay-address:tigez", JSON.stringify({ channel: 41, group: 3 }));
    let socket: FakeSocket | null = null;
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
          <FrontPage />
        </WsProvider>,
      ),
    );
    act(() => {
      socket!.emitOpen();
    });
    act(() => {
      socket!.emitMessage(snapshot({ devices: [device(9, { name: "tigez" })] }));
    });

    const offer = el.querySelector('[data-testid="radio-migration-offer-9"]');
    const dismissButton = Array.from(offer!.querySelectorAll("button")).find((b) => b.textContent === "Dismiss");
    act(() => {
      dismissButton!.click();
    });

    expect(socket!.sent).toEqual([]);
    expect(window.localStorage.getItem("robot-console:relay-address:tigez")).toBeNull();
  });

  it("no offer at all when no device in the snapshot matches the stored name", () => {
    window.localStorage.setItem("robot-console:relay-address:nomatch", JSON.stringify({ channel: 41, group: 3 }));
    let socket: FakeSocket | null = null;
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
          <FrontPage />
        </WsProvider>,
      ),
    );
    act(() => {
      socket!.emitOpen();
    });
    act(() => {
      socket!.emitMessage(snapshot({ devices: [device(9, { name: "tigez" })] }));
    });

    expect(el.querySelector(".radio-migration-offer")).toBeNull();
  });
});
