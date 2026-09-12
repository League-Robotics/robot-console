// @vitest-environment jsdom
/**
 * RelayPage.test.tsx — component-level tests for the relay device page
 * (sprint 015 ticket 008; SUC-003, SUC-004, SUC-005, SUC-006, SUC-009),
 * rewritten against the `Snapshot` contract: `relays[]`/the bridged
 * child's own `links[]` entry drive every branch here, not a `-via-`
 * endpoint id scanned out of a flat endpoint list.
 *
 * Central to this ticket: Connect/Switch send **exactly one**
 * `{ type: "session-open", relayLinkId, name }` message, whether or not
 * a child is already bridged -- never a client-sequenced
 * `session-close` then `session-open` pair (the retired two-message
 * switch this ticket deletes, not adapts). The reconciler
 * (`connect/reconciler.ts`'s `planUserOpen`, ticket 002) is what turns
 * that single request into a close-old + open-new job, host-side.
 *
 * `RobotPage.tsx` is mocked here with a thin stub for the connected-
 * child branch regardless of its own migration state (sprint 015 ticket
 * 009) -- this file's job is `RelayPage`'s own dispatch/rendering, not
 * `RobotPage`'s internals.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Snapshot, SnapshotDevice, SnapshotLink, SnapshotRelay } from "@robot-console/host/src/wsMessages.js";
import { RelayPage } from "./RelayPage";
import { WsProvider } from "../ws/WsProvider";
import { FakeSocket } from "../testing/FakeSocket";
import { withRouter } from "../testing/renderWithRouter";

vi.mock("./RobotPage", () => ({
  RobotPage: ({ device }: { device: SnapshotDevice }) => (
    <section aria-label="Robot device" data-testid="robot-page-stub">
      {device.name}
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

const RELAY_LINK_ID = "usb-relay-1";

function relayDevice(overrides: Partial<Omit<SnapshotDevice, "links">> = {}): SnapshotDevice {
  return device(3, {
    name: "rly01",
    kind: "relay",
    links: [link(RELAY_LINK_ID, { state: "connected" })],
    ...overrides,
  });
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

function mountRelayPage(relay: SnapshotDevice): { el: HTMLDivElement; socket: () => FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    withRouter(
      <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
        <RelayPage device={relay} />
      </WsProvider>,
      { initialEntries: [`/d/${relay.links[0]!.id}`] },
    ),
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: () => socket! };
}

function pushSnapshot(socket: () => FakeSocket, overrides: Partial<Snapshot>): void {
  act(() => {
    socket().emitMessage(snapshot(overrides));
  });
}

describe("RelayPage: not connected", () => {
  it("renders the relay's own name as its heading", () => {
    const { el, socket } = mountRelayPage(relayDevice({ name: "rly01" }));
    pushSnapshot(socket, { devices: [relayDevice({ name: "rly01" })] });
    expect(el.querySelector("h2")?.textContent).toBe("rly01");
  });

  it("renders 'idle' when relays[] reports lease: null and no bridging", () => {
    const { el, socket } = mountRelayPage(relayDevice());
    pushSnapshot(socket, {
      devices: [relayDevice()],
      relays: [{ linkId: RELAY_LINK_ID, lease: null }],
    });
    expect(el.querySelector('[data-testid="relay-idle"]')?.textContent).toBe("idle");
  });

  it("renders 'idle · sweeping' when relays[] reports lease: 'sweep'", () => {
    const { el, socket } = mountRelayPage(relayDevice());
    pushSnapshot(socket, {
      devices: [relayDevice()],
      relays: [{ linkId: RELAY_LINK_ID, lease: "sweep" }],
    });
    expect(el.querySelector('[data-testid="relay-idle"]')?.textContent).toBe("idle · sweeping");
  });

  it("renders 'idle' (not an error) when the snapshot has no relays[] entry for this relay at all", () => {
    const { el, socket } = mountRelayPage(relayDevice());
    pushSnapshot(socket, { devices: [relayDevice()] });
    expect(el.querySelector('[data-testid="relay-idle"]')?.textContent).toBe("idle");
  });

  it("renders the in-flight bridging state from relays[].bridging, not the idle line", () => {
    const relays: SnapshotRelay[] = [{ linkId: RELAY_LINK_ID, lease: "session", bridging: { state: "connecting", robotName: "GoPiv" } }];
    const { el, socket } = mountRelayPage(relayDevice());
    pushSnapshot(socket, { devices: [relayDevice()], relays });
    expect(el.querySelector('[data-testid="relay-autoconnecting"]')?.textContent).toBe("Connecting to GoPiv…");
    expect(el.querySelector('[data-testid="relay-idle"]')).toBeNull();
  });

  it("renders the failure reason from relays[].bridging.error", () => {
    const relays: SnapshotRelay[] = [{ linkId: RELAY_LINK_ID, lease: null, bridging: { state: "failed", robotName: "GoPiv", error: "GoPiv did not respond" } }];
    const { el, socket } = mountRelayPage(relayDevice());
    pushSnapshot(socket, { devices: [relayDevice()], relays });
    expect(el.querySelector('[data-testid="relay-bridge-failed"]')?.textContent).toBe("GoPiv did not respond");
  });

  it("renders the relay's own DeviceConsole while no child is bridged", () => {
    const { el, socket } = mountRelayPage(relayDevice());
    pushSnapshot(socket, { devices: [relayDevice()] });
    expect(el.querySelector('[aria-label="Console"]')).not.toBeNull();
  });

  it("lists every kind: robot device's name in the picker, sorted", () => {
    const { el, socket } = mountRelayPage(relayDevice());
    pushSnapshot(socket, { devices: [relayDevice(), device(5, { name: "vevav" }), device(6, { name: "gopiv" })] });
    const select = el.querySelector<HTMLSelectElement>('[data-testid="relay-robot-select"]');
    const optionValues = Array.from(select!.querySelectorAll("option")).map((o) => o.value);
    expect(optionValues).toEqual(["", "gopiv", "vevav"]);
  });

  it("Connect is disabled until a robot is picked", () => {
    const { el, socket } = mountRelayPage(relayDevice());
    pushSnapshot(socket, { devices: [relayDevice(), device(5, { name: "vevav" })] });
    expect(el.querySelector<HTMLButtonElement>('[data-testid="relay-connect"]')!.disabled).toBe(true);
  });

  it("Connect sends exactly one {type: 'session-open', relayLinkId, name} message, never a session-close", () => {
    const { el, socket } = mountRelayPage(relayDevice());
    pushSnapshot(socket, { devices: [relayDevice(), device(5, { name: "vevav" })] });

    const select = el.querySelector<HTMLSelectElement>('[data-testid="relay-robot-select"]')!;
    act(() => {
      select.value = "vevav";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="relay-connect"]')!.click();
    });

    expect(socket().sent).toEqual([JSON.stringify({ type: "session-open", relayLinkId: RELAY_LINK_ID, name: "vevav" })]);
  });

  // Ticket 011 (carried from 009's send-gating sweep): Connect disables
  // when the socket closes, even with a robot already picked -- see
  // `useSendable`'s own doc comment (a relay link never has a `session`
  // of its own, so this button had no session-based gate to begin with).
  it("Connect disables once the socket closes, and stays disabled until a fresh snapshot confirms reconnect", () => {
    const { el, socket } = mountRelayPage(relayDevice());
    pushSnapshot(socket, { devices: [relayDevice(), device(5, { name: "vevav" })] });

    const select = el.querySelector<HTMLSelectElement>('[data-testid="relay-robot-select"]')!;
    act(() => {
      select.value = "vevav";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(el.querySelector<HTMLButtonElement>('[data-testid="relay-connect"]')!.disabled).toBe(false);

    act(() => {
      socket().close();
    });
    expect(el.querySelector<HTMLButtonElement>('[data-testid="relay-connect"]')!.disabled).toBe(true);

    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="relay-connect"]')!.click();
    });
    expect(socket().sent).toEqual([]);
  });
});

describe("RelayPage: connected", () => {
  function childLink(overrides: Partial<SnapshotLink> = {}): SnapshotLink {
    return link("radio-vevav-via-usb-relay-1", {
      transport: "radio",
      state: "connected",
      via: { relayLinkId: RELAY_LINK_ID, relayName: "rly01", channel: 55, group: 114, addressSource: "derived" },
      ...overrides,
    });
  }

  function childDevice(overrides: Partial<Omit<SnapshotDevice, "links">> = {}, linkOverrides: Partial<SnapshotLink> = {}): SnapshotDevice {
    return device(5, { name: "vevav", radio: { channel: 55, group: 114, source: "derived" }, links: [childLink(linkOverrides)], ...overrides });
  }

  it("renders 'Connected to <name> via <relay> on channel X, group Y' when the child link is connected", () => {
    const { el, socket } = mountRelayPage(relayDevice());
    pushSnapshot(socket, { devices: [relayDevice(), childDevice()] });

    expect(el.querySelector('[data-testid="relay-connected"]')?.textContent).toBe(
      "Connected to vevav via rly01 on channel 55, group 114",
    );
  });

  it("mounts the child's AddressSourceChip from the child device's own radio field", () => {
    const { el, socket } = mountRelayPage(relayDevice());
    pushSnapshot(socket, { devices: [relayDevice(), childDevice({ radio: { channel: 55, group: 114, source: "override" } })] });

    const chip = el.querySelector('[data-testid="address-source-chip"]');
    expect(chip?.textContent).toContain("ch 55 / grp 114");
    expect(chip?.textContent).toContain("set for this device");
  });

  it("mounts RobotPage for the connected child device", () => {
    const { el, socket } = mountRelayPage(relayDevice());
    pushSnapshot(socket, { devices: [relayDevice(), childDevice()] });

    expect(el.querySelector('[aria-label="Robot device"]')?.textContent).toBe("vevav");
  });

  it("renders 'Connection to <name> lost' when the child exists but its link is not connected", () => {
    const { el, socket } = mountRelayPage(relayDevice());
    pushSnapshot(socket, {
      devices: [relayDevice(), childDevice({}, { state: "unresponsive", reason: "no reply" })],
    });

    expect(el.querySelector('[data-testid="relay-lost"]')?.textContent).toBe("Connection to vevav lost: no reply");
    // The connected layout (Disconnect, RobotPage) stays mounted so the
    // student can retry or clean up -- driven by the child's existence,
    // not its link's state.
    expect(el.querySelector('[data-testid="relay-disconnect"]')).not.toBeNull();
    expect(el.querySelector('[aria-label="Robot device"]')).not.toBeNull();
  });

  it("Disconnect sends session-close for the child's own link id", () => {
    const { el, socket } = mountRelayPage(relayDevice());
    pushSnapshot(socket, { devices: [relayDevice(), childDevice()] });

    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="relay-disconnect"]')!.click();
    });

    expect(socket().sent).toEqual([JSON.stringify({ type: "session-close", linkId: "radio-vevav-via-usb-relay-1" })]);
  });

  it("Switch (picking a different name while connected) sends exactly one session-open, never a session-close first", () => {
    const { el, socket } = mountRelayPage(relayDevice());
    pushSnapshot(socket, { devices: [relayDevice(), childDevice(), device(6, { name: "gopiv" })] });

    const select = el.querySelector<HTMLSelectElement>('[data-testid="relay-robot-select"]')!;
    expect(select.value).toBe("vevav");
    act(() => {
      select.value = "gopiv";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="relay-connect"]')!.click();
    });

    expect(socket().sent).toEqual([JSON.stringify({ type: "session-open", relayLinkId: RELAY_LINK_ID, name: "gopiv" })]);
    expect(socket().sent.some((raw) => JSON.parse(raw).type === "session-close")).toBe(false);
  });

  it("the connect bar's button reads 'Switch' while connected", () => {
    const { el, socket } = mountRelayPage(relayDevice());
    pushSnapshot(socket, { devices: [relayDevice(), childDevice()] });
    expect(el.querySelector('[data-testid="relay-connect"]')?.textContent).toBe("Switch");
  });

  it("notes that the relay's own console returns after Disconnect", () => {
    const { el, socket } = mountRelayPage(relayDevice());
    pushSnapshot(socket, { devices: [relayDevice(), childDevice()] });
    expect(el.textContent).toContain("The relay's own console returns after Disconnect.");
  });
});
