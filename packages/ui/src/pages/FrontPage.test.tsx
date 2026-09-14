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
import { DevicesList, FrontPage, RadioMigrationOffers } from "./FrontPage";
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
    firmware: { relay: { configured: false }, robot: { configured: false } },
    wifi: { ssid: null, source: null },
    tasks: [],
    ...overrides,
  };
}

// `linkStatusText`'s own cases (renamed `linkStateText`) moved to
// `deviceDisplay.test.ts` (ticket 017-007 -- moved there along with the
// function itself, out of this module's former local copy). Not
// re-tested here.

/** The lightning Flash trigger inside a card (ticket 018-015) -- an
 * icon-only button now, so it's found by its accessible name ("Flash
 * <name>") rather than by visible text, unlike `FlashDialog`'s default
 * text trigger (`AppHeader.test.tsx`'s own `flashTrigger` helper, which
 * still matches on `textContent === "Flash"` for its own, un-iconified,
 * call site). */
function findFlashTrigger(container: Element): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((b) => b.getAttribute("aria-label")?.startsWith("Flash")) ?? undefined;
}

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

  it("018-010 item 3: shows a plain 'Role unknown' for a robot with no announced role", () => {
    const el = mount(withRouter(<DevicesList status="open" devices={[device(1, { role: null })]} unassigned={[]} />));
    expect(el.textContent ?? "").toContain("Role unknown");
  });

  it("018-010 item 3: labels a roleless relay by its own links' transport instead of 'Role unknown'", () => {
    const el = mount(
      withRouter(
        <DevicesList
          status="open"
          devices={[
            device(1, {
              kind: "relay",
              role: null,
              links: [link("mbrelay-torture", { transport: "mbrelay" })],
            }),
          ]}
          unassigned={[]}
        />,
      ),
    );
    expect(el.textContent ?? "").toContain("mbrelay host");
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

  it("renders the open arrow as a real link to the device's primary (usable) link page", () => {
    // Extended scope (team-lead, 2026-09-13), item B: a card's open
    // arrow only ever leads to a usable link (state "connected" AND an
    // open session) -- `link()`'s own default has no session, so this
    // test opens one explicitly rather than relying on the old
    // "falls back to links[0] regardless" behavior this ticket removes.
    const el = mount(
      withRouter(
        <DevicesList
          status="open"
          devices={[
            device(1, {
              links: [link("usb-1", { session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null } })],
            }),
          ]}
          unassigned={[]}
        />,
      ),
    );
    const openArrow = el.querySelector('[data-testid="device-open-1"]');
    expect(openArrow?.tagName).toBe("A");
    expect(openArrow?.getAttribute("href")).toBe("/d/usb-1");
  });

  it("shows a distinguishing calibration badge with the program's release version, never device.version (018-017: the pxt-nezha-diffdrive library version)", () => {
    const el = mount(
      withRouter(<DevicesList status="open" devices={[device(1, { program: "calibration-0.20260907.2", version: "1.20260912.8" })]} unassigned={[]} />),
    );
    const badge = el.querySelector('[data-testid="calibration-badge"]');
    expect(badge?.textContent).toBe("Calibration robot · 0.20260907.2");
  });

  it("shows the program string as-is in the badge when it doesn't parse to a version, regardless of device.version", () => {
    const el = mount(
      withRouter(<DevicesList status="open" devices={[device(1, { program: "calibration-x", version: "1.20260912.8" })]} unassigned={[]} />),
    );
    expect(el.querySelector('[data-testid="calibration-badge"]')?.textContent).toBe("Calibration robot · calibration-x");
  });

  it("shows no calibration badge for a plain program (regression)", () => {
    const el = mount(withRouter(<DevicesList status="open" devices={[device(1, { program: "diffdrive" })]} unassigned={[]} />));
    expect(el.querySelector('[data-testid="calibration-badge"]')).toBeNull();
  });

  it("shows the Linked pill only when some link is connected AND has answered (ticket 018-010)", () => {
    const linked = mount(
      withRouter(
        <DevicesList
          status="open"
          devices={[
            device(1, {
              links: [
                link("usb-1", {
                  state: "connected",
                  session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null, answeredAt: Date.now() },
                }),
              ],
            }),
          ]}
          unassigned={[]}
        />,
      ),
    );
    expect(linked.querySelector(".device-linked-pill")).not.toBeNull();

    if (root) act(() => root!.unmount());
    if (container) container.remove();

    const notLinked = mount(withRouter(<DevicesList status="open" devices={[device(1, { links: [link("usb-1", { state: "connectable" })] })]} unassigned={[]} />));
    expect(notLinked.querySelector(".device-linked-pill")).toBeNull();
  });

  // Ticket 018-010 bench defect: `vevov`'s mbserial bridge accepted a
  // TCP connection and flipped its link to `connected` while its own
  // robot never once replied to `HELLO` -- the pill must not show for
  // merely `state === "connected"` with no session, or a session that
  // has never answered.
  it("never shows the Linked pill for a connected link that has no session, or a session that has never answered", () => {
    const noSession = mount(withRouter(<DevicesList status="open" devices={[device(1, { links: [link("usb-1", { state: "connected" })] })]} unassigned={[]} />));
    expect(noSession.querySelector(".device-linked-pill")).toBeNull();

    if (root) act(() => root!.unmount());
    if (container) container.remove();

    const neverAnswered = mount(
      withRouter(
        <DevicesList
          status="open"
          devices={[
            device(1, {
              links: [link("usb-1", { state: "connected", session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null } })],
            }),
          ]}
          unassigned={[]}
        />,
      ),
    );
    expect(neverAnswered.querySelector(".device-linked-pill")).toBeNull();
  });
});

describe("multi-link device (host already groups links under one device)", () => {
  function multiLinkDevice(): SnapshotDevice {
    return device(1, {
      name: "vevov",
      links: [
        link("usb-vevov", {
          state: "connected",
          session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null, answeredAt: Date.now() },
        }),
        link("wifi-vevov", { transport: "wifi", label: "WiFi · vevov.local:7654", state: "failed", reason: "could not reach vevov.local:7654" }),
      ],
    });
  }

  // Ticket 017-010 (team-lead bench walk, 2026-09-13): this used to
  // assert an open arrow *into the non-usable wifi link* -- exactly the
  // bench complaint ("How is it letting me go into it if it's not
  // connected?"). A per-link arrow now requires `isLinkUsable(link)`
  // itself, not merely "isn't the primary", so the non-usable wifi row
  // gets no arrow -- only a Connect button, since `failed` is in
  // `CONNECT_BUTTON_STATES`.
  it("stakeholder 2026-09-13: each live link is an icon chip; the usable chip opens the device, the failed chip carries the details in its popover", () => {
    const el = mount(withRouter(<DevicesList status="open" devices={[multiLinkDevice()]} unassigned={[]} sendable={true} />));
    const usbChip = el.querySelector('[data-testid="device-chip-usb-vevov"]');
    const wifiChip = el.querySelector('[data-testid="device-chip-wifi-vevov"]');
    expect(usbChip?.getAttribute("data-state")).toBe("linked");
    expect(usbChip?.querySelector('a.device-chip-face')?.getAttribute("href")).toBe("/d/usb-vevov");
    expect(usbChip?.querySelector('svg[data-icon="usb"]')).not.toBeNull();
    expect(wifiChip?.getAttribute("data-state")).toBe("failed");
    expect(wifiChip?.querySelector("a.device-chip-face")).toBeNull();
    expect(wifiChip?.querySelector('svg[data-icon="wifi"]')).not.toBeNull();
    expect(wifiChip?.querySelector(".device-chip-popover")?.textContent).toContain("Couldn't connect: could not reach vevov.local:7654");
    expect(el.querySelector('[data-testid="device-role-1"]')?.textContent).toBe("Role unknown");
  });

  it("stakeholder 2026-09-13: the home page groups robots first, then radio bridges", () => {
    const relay = device(7, { name: "vitut", kind: "relay", role: "RADIOBRIDGE", links: [link("usb-vitut", { state: "connectable", transport: "usb" })] });
    const el = mount(withRouter(<DevicesList status="open" devices={[relay, multiLinkDevice()]} unassigned={[]} />));
    const groups = Array.from(el.querySelectorAll(".devices-group")).map((g) => g.getAttribute("data-testid"));
    expect(groups).toEqual(["devices-group-robots", "devices-group-bridges"]);
    expect(el.querySelector('[data-testid="devices-group-robots"] [data-testid="device-card-1"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="devices-group-bridges"] [data-testid="device-card-7"]')).not.toBeNull();
  });

  it("gives only the usable (primary) link a card open arrow; the non-usable link gets a row Connect button, no arrow", () => {
    const opens: string[] = [];
    const el = mount(
      withRouter(
        <DevicesList status="open" devices={[multiLinkDevice()]} unassigned={[]} sendable={true} onLinkConnect={(linkId) => opens.push(linkId)} />,
      ),
    );

    expect(el.querySelectorAll("h3.device-name")).toHaveLength(1);
    expect(el.querySelector('[data-testid="device-open-1"]')?.getAttribute("href")).toBe("/d/usb-vevov");

    const rows = el.querySelectorAll(".device-connections li");
    expect(rows).toHaveLength(2);
    const wifiRow = el.querySelector('[data-testid="device-link-wifi-vevov"]');
    expect(wifiRow?.textContent).toContain("WiFi · vevov.local:7654");
    expect(wifiRow?.textContent).toContain("Couldn't connect: could not reach vevov.local:7654");

    // No arrow anywhere except the card's own, into the usable link.
    expect(el.querySelectorAll('[data-testid^="device-link-open-"]')).toHaveLength(0);
    expect(el.querySelector('[data-testid="device-link-open-wifi-vevov"]')).toBeNull();
    expect(el.querySelector('[data-testid="device-link-open-usb-vevov"]')).toBeNull();
    expect(el.querySelector('[data-testid="device-link-usb-vevov"]')?.textContent).toContain("Linked");
    expect(el.querySelectorAll("a a")).toHaveLength(0);

    // The non-usable wifi link is still `failed`, one of
    // `CONNECT_BUTTON_STATES`, so it gets a Connect button that sends
    // session-open for its own link id -- regardless of the card
    // already having a usable primary link on usb-vevov.
    const connect = el.querySelector<HTMLButtonElement>('[data-testid="device-link-connect-wifi-vevov"]');
    expect(connect).not.toBeNull();
    expect(connect!.disabled).toBe(false);
    act(() => {
      connect!.click();
    });
    expect(opens).toEqual(["wifi-vevov"]);

    // The usable primary link itself gets no Connect button: "connected"
    // is not in CONNECT_BUTTON_STATES.
    expect(el.querySelector('[data-testid="device-link-connect-usb-vevov"]')).toBeNull();
  });

  it("gives every usable link its own row arrow when a card has two usable links, plus the card's own arrow to the primary", () => {
    const el = mount(
      withRouter(
        <DevicesList
          status="open"
          devices={[
            device(1, {
              name: "vevov",
              links: [
                link("usb-vevov", {
                  state: "connected",
                  session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null },
                }),
                link("wifi-vevov", {
                  transport: "wifi",
                  label: "WiFi · vevov.local:7654",
                  state: "connected",
                  session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null },
                }),
              ],
            }),
          ]}
          unassigned={[]}
        />,
      ),
    );

    // Primary is the first usable link (usb-vevov) -- the card's own
    // arrow leads there, and it gets no extra row arrow.
    expect(el.querySelector('[data-testid="device-open-1"]')?.getAttribute("href")).toBe("/d/usb-vevov");
    expect(el.querySelector('[data-testid="device-link-open-usb-vevov"]')).toBeNull();

    // The second usable link is not the primary, so it gets its own
    // small row arrow.
    expect(el.querySelector('[data-testid="device-link-open-wifi-vevov"]')?.getAttribute("href")).toBe("/d/wifi-vevov");

    // Exactly one card arrow + one row arrow across the whole card.
    expect(el.querySelectorAll('[data-testid^="device-link-open-"], [data-testid^="device-open-"]')).toHaveLength(2);
  });
});

describe("extended scope (team-lead, 2026-09-13), item B: a card with no usable link", () => {
  it("renders no open arrow at all (neither the card's own nor any per-link one) when no link is usable", () => {
    const el = mount(
      withRouter(
        <DevicesList
          status="open"
          devices={[
            device(1, {
              name: "zapuz",
              links: [
                link("usb-zapuz", {
                  state: "unresponsive",
                  reason: "no reply to 3 STATUS polls -- link presumed dead",
                  session: { seq: 4, pending: 0, lastDone: 4, lastDoneReason: "none", robotStatus: null, functions: null },
                }),
              ],
            }),
          ]}
          unassigned={[]}
        />,
      ),
    );
    expect(el.querySelector('[data-testid="device-open-1"]')).toBeNull();
    expect(el.querySelector('[data-testid="device-link-open-usb-zapuz"]')).toBeNull();
  });

  it("shows each link's state text (with its reason in plain words folded in, once) plus a Connect button that sends session-open, gated by sendable", () => {
    const opens: string[] = [];
    const el = mount(
      withRouter(
        <DevicesList
          status="open"
          devices={[
            device(1, {
              name: "zapuz",
              links: [
                link("usb-zapuz", {
                  state: "unresponsive",
                  reason: "no reply to 3 STATUS polls -- link presumed dead",
                }),
              ],
            }),
          ]}
          unassigned={[]}
          sendable={true}
          onLinkConnect={(linkId) => opens.push(linkId)}
        />,
      ),
    );
    const row = el.querySelector('[data-testid="device-link-usb-zapuz"]');
    // Ticket 017-010 fix (team-lead bench evidence, 2026-09-13): the raw
    // `link.reason` used to also render in its own
    // `device-link-reason-*` span, duplicating the exact same sentence
    // `linkStateText` already shows (unmapped, on top of that) --
    // `plainFailureReason` folds it into the state text once and that
    // separate span is gone outright.
    expect(row?.textContent).toContain("Couldn't connect: stopped answering");
    expect(row?.textContent?.match(/stopped answering/g)).toHaveLength(1);
    expect(el.querySelector('[data-testid="device-link-reason-usb-zapuz"]')).toBeNull();
    const connect = el.querySelector<HTMLButtonElement>('[data-testid="device-link-connect-usb-zapuz"]');
    expect(connect).not.toBeNull();
    expect(connect!.disabled).toBe(false);
    act(() => {
      connect!.click();
    });
    expect(opens).toEqual(["usb-zapuz"]);
  });

  it("disables the Connect button when sendable is false", () => {
    const el = mount(
      withRouter(
        <DevicesList
          status="open"
          devices={[device(1, { links: [link("usb-1", { state: "failed", reason: "boom" })] })]}
          unassigned={[]}
          sendable={false}
        />,
      ),
    );
    expect(el.querySelector<HTMLButtonElement>('[data-testid="device-link-connect-usb-1"]')!.disabled).toBe(true);
  });

  it("offers no Connect button for a state not in the connectable set (e.g. connecting)", () => {
    const el = mount(
      withRouter(
        <DevicesList status="open" devices={[device(1, { links: [link("usb-1", { state: "connecting" })] })]} unassigned={[]} />,
      ),
    );
    expect(el.querySelector('[data-testid="device-link-connect-usb-1"]')).toBeNull();
  });

  it("a relay card keeps its existing open arrow regardless of its own link having no usable session", () => {
    const el = mount(
      withRouter(
        <DevicesList
          status="open"
          devices={[device(2, { name: "torture", kind: "relay", links: [link("mbrelay-torture", { transport: "mbrelay", state: "connected" })] })]}
          unassigned={[]}
        />,
      ),
    );
    expect(el.querySelector('[data-testid="device-open-2"]')?.getAttribute("href")).toBe("/d/mbrelay-torture");
  });

  // Bench defect (team-lead walk 017-012, 2026-09-13): the `torture`
  // relay card showed a row-level Connect button on its own mbrelay
  // link -- opening a relay pool's own link is not a student action,
  // the relay card already gets its robot-picker Connect via
  // `RelayConnectControls`. The button must stay suppressed for every
  // state in `CONNECT_BUTTON_STATES`, not just the `connected` case the
  // pre-existing open-arrow test above happens to use.
  it("never shows a row-level Connect button on a relay card's own link, in any connectable state", () => {
    const el = mount(
      withRouter(
        <DevicesList
          status="open"
          sendable={true}
          devices={[
            device(2, {
              name: "torture",
              kind: "relay",
              links: [link("mbrelay-torture", { transport: "mbrelay", label: "mbrelay · torture.local:8760", state: "connectable" })],
            }),
          ]}
          unassigned={[]}
        />,
      ),
    );
    expect(el.querySelector('[data-testid="device-link-connect-mbrelay-torture"]')).toBeNull();
    expect(el.querySelector('[data-testid="device-link-mbrelay-torture"]')?.textContent).toContain("mbrelay · torture.local:8760");
  });
});

describe("front-page lightning Flash button (ticket 018-015)", () => {
  it("shows a lightning Flash trigger, with an accessible 'Flash <name>' label, on a device card with a current usb link", () => {
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => new FakeSocket()}>
          <DevicesList status="open" devices={[device(1, { name: "zeguz" })]} unassigned={[]} />
        </WsProvider>,
      ),
    );
    const card = el.querySelector('[data-testid="device-card-1"]')!;
    const flashTrigger = findFlashTrigger(card);
    expect(flashTrigger).toBeDefined();
    expect(flashTrigger!.getAttribute("aria-label")).toBe("Flash zeguz");
    // Icon-only -- no visible "Flash" text.
    expect(flashTrigger!.textContent).toBe("");
  });

  it("shows no lightning Flash trigger when the device has no usb link at all", () => {
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => new FakeSocket()}>
          <DevicesList
            status="open"
            devices={[device(1, { name: "zeguz", links: [link("radio-1", { transport: "radio", state: "connected" })] })]}
            unassigned={[]}
          />
        </WsProvider>,
      ),
    );
    const card = el.querySelector('[data-testid="device-card-1"]')!;
    expect(findFlashTrigger(card)).toBeUndefined();
  });

  it("shows no lightning Flash trigger when the device's only usb link has gone stale", () => {
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => new FakeSocket()}>
          <DevicesList status="open" devices={[device(1, { name: "zeguz", links: [link("usb-1", { state: "stale" })] })]} unassigned={[]} />
        </WsProvider>,
      ),
    );
    const card = el.querySelector('[data-testid="device-card-1"]')!;
    expect(findFlashTrigger(card)).toBeUndefined();
  });

  it("does not shift the open arrow, and reserves no empty flash slot, on a card with no usb link", () => {
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => new FakeSocket()}>
          <DevicesList
            status="open"
            devices={[
              device(1, {
                name: "zeguz",
                links: [
                  link("wifi-1", {
                    transport: "wifi",
                    state: "connected",
                    session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null },
                  }),
                ],
              }),
            ]}
            unassigned={[]}
          />
        </WsProvider>,
      ),
    );
    const card = el.querySelector('[data-testid="device-card-1"]')!;
    expect(card.querySelector('[data-testid="device-open-1"]')).not.toBeNull();
    expect(findFlashTrigger(card)).toBeUndefined();
  });

  it("clicking the lightning trigger opens the flash modal offering relay firmware, robot/calibration firmware, and a local .hex upload", () => {
    let socket: FakeSocket | null = null;
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
          <DevicesList status="open" devices={[device(1, { name: "zeguz" })]} unassigned={[]} />
        </WsProvider>,
      ),
    );
    act(() => {
      socket!.emitOpen();
    });
    const card = el.querySelector('[data-testid="device-card-1"]')!;
    const flashTrigger = findFlashTrigger(card)!;
    act(() => {
      flashTrigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const text = el.textContent ?? "";
    expect(text).toContain("Flash zeguz");
    expect(text).toContain("Flash relay firmware");
    expect(text).toContain("Flash robot firmware");
    expect(text).toContain("Flash a hex file from disk");
  });

  it("gives the unassigned-board card's Flash trigger the same lightning-icon treatment as a device card's", () => {
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
    const flashTrigger = findFlashTrigger(card);
    expect(flashTrigger).toBeDefined();
    expect(flashTrigger!.getAttribute("aria-label")).toBe("Flash USB · /dev/tty.usbmodem-unknown");
  });
});

describe("bench defect 010 addendum (2026-09-13): a refused/failed Connect shows the host's notice on the row", () => {
  // `DevicesList` on its own has no `linkNotices` to read (it takes no
  // `WsProvider`-dependent hook of its own -- `DeviceConnectionRow`'s own
  // doc comment) -- this exercises the whole path end-to-end through
  // `FrontPage` + `WsProvider` + a `FakeSocket`, exactly like a real
  // Connect click and the host's own `notice` reply.
  it("Connect on a connectable link, refused by the host, renders that refusal on the link's own row within one snapshot tick", () => {
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
      socket!.emitMessage(
        snapshot({
          devices: [device(1, { name: "tovez", links: [link("usb-tovez", { state: "connectable" })] })],
        }),
      );
    });

    const connect = el.querySelector<HTMLButtonElement>('[data-testid="device-link-connect-usb-tovez"]');
    expect(connect).not.toBeNull();
    act(() => {
      connect!.click();
    });
    expect(socket!.sent).toContainEqual(JSON.stringify({ type: "session-open", linkId: "usb-tovez" }));

    // The host refuses (bench defect 010's own dead-transport case, or
    // any other `describeUserOpenRefusal` reason) and broadcasts a
    // link-scoped notice -- exactly `server.ts`'s existing
    // `session-open` handler behavior, already wired before this fix;
    // what was missing was the front page ever reading it.
    act(() => {
      socket!.emitMessage({
        type: "notice",
        level: "warn",
        linkId: "usb-tovez",
        text: "connect refused: already open",
        at: 1,
        seq: 2,
      });
    });

    const row = el.querySelector('[data-testid="device-link-usb-tovez"]');
    expect(row?.textContent).toContain("connect refused: already open");
    expect(el.querySelector('[data-testid="device-link-notice-usb-tovez"]')?.textContent).toBe(
      "connect refused: already open",
    );
  });

  it("the notice clears once the link is next reported connected", () => {
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
      socket!.emitMessage(
        snapshot({ devices: [device(1, { name: "tovez", links: [link("usb-tovez", { state: "connectable" })] })] }),
      );
    });
    act(() => {
      socket!.emitMessage({ type: "notice", level: "warn", linkId: "usb-tovez", text: "connect refused: already open", at: 1, seq: 2 });
    });
    expect(el.querySelector('[data-testid="device-link-notice-usb-tovez"]')).not.toBeNull();

    act(() => {
      socket!.emitMessage(
        snapshot({
          seq: 3,
          devices: [
            device(1, {
              name: "tovez",
              links: [
                link("usb-tovez", {
                  state: "connected",
                  session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null },
                }),
              ],
            }),
          ],
        }),
      );
    });
    expect(el.querySelector('[data-testid="device-link-notice-usb-tovez"]')).toBeNull();
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

  it("restores the Flash trigger on an unassigned board's card (sprint 015 ticket 008), now a lightning icon (ticket 018-015)", () => {
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
    const flashTrigger = findFlashTrigger(card);
    expect(flashTrigger).toBeDefined();
    // Ticket 018-015: the trigger is icon-only now -- no visible "Flash"
    // text -- so its accessible name is what a screen reader (and this
    // test) has to go on.
    expect(flashTrigger!.textContent).toBe("");
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
    expect(findFlashTrigger(card)).toBeUndefined();
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
    const flashTrigger = findFlashTrigger(card)!;
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

  it("FrontPage lists a device whose every link is stale under not-seen-recently, not as an available card", () => {
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
      socket!.emitMessage(
        snapshot({
          devices: [
            device(9, { name: "zapig", links: [link("usb-z", { state: "stale", transport: "usb" })] }),
            device(10, { name: "gopiv", links: [link("wifi-g", { state: "connectable", transport: "wifi" })] }),
          ],
        }),
      );
    });
    expect(el.querySelector('[data-testid="not-seen-device-9"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="not-seen-device-10"]')).toBeNull();
    expect(el.textContent).toContain("gopiv");
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

  // Ticket 017-010 (team-lead bench evidence, 2026-09-13): "the same
  // robot appears twice" -- `tovez` id 2665 (`owned: 1`, no links, the
  // known-robots.json placeholder) and `tovez` id 2314287040 (`owned:
  // 0`, real USB serial, SWD-named) both showed up on the front page at
  // once: a real device card AND "Not seen recently · tovez". Even with
  // the placeholder-merge fix, a not-yet-merged snapshot moment must
  // never render this -- `FrontPage` itself filters `notSeenRecently` by
  // name against every device that already has a card, independent of
  // whether the store has merged the two rows yet.
  it("never lists a name under 'Not seen recently' that already has a device card on the page (the tovez bug)", () => {
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
      socket!.emitMessage(
        snapshot({
          devices: [
            // The real, currently-linked row -- gets a card.
            device(2314287040, { name: "tovez", links: [link("usb-tovez", { state: "connected" })] }),
            // The unmerged known-robots.json placeholder -- zero links,
            // would normally fall into "Not seen recently" under its own
            // name.
            device(2665, { name: "tovez", links: [] }),
          ],
        }),
      );
    });
    expect(el.querySelector('[data-testid="device-card-2314287040"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="not-seen-device-2665"]')).toBeNull();
    // No "Not seen recently" section at all -- its only candidate
    // (2665) was filtered out, leaving nothing to render the section
    // for.
    expect(el.querySelector(".remembered-robots")).toBeNull();
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
          session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null, answeredAt: Date.now() },
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

  // Ticket 018-010 bench defect: a stale `failed` child link with no
  // real bridge session used to still show Switch/Disconnect "as if
  // bridging". This link has no `session` at all (never got past
  // identify) -- only a plain Connect should show, offering the student
  // a way to try again, not a Disconnect for a session that never
  // existed.
  it("a child whose link has dropped (no session) shows 'Connection to <name> lost' and only a Connect button, not Switch/Disconnect", () => {
    const child = device(4, {
      name: "vevav",
      links: [
        link("usb-relay-1-via-vevav", {
          transport: "radio",
          state: "failed",
          reason: "no reply from vevav",
          // Recent `since` (ticket 018-010's own `currentRelayChild`
          // recency gate) -- this test is about Switch/Disconnect
          // gating, not staleness, so it pins the drop to just now.
          since: Date.now() - 1000,
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
    expect(buttons).toContain("Connect");
    expect(buttons).not.toContain("Switch");
    expect(buttons).not.toContain("Disconnect");
  });

  // The `session`-kept counterpart: `connect/harvester.ts` keeps a
  // session row open while a link is merely `unresponsive` (not yet
  // reaped) -- `RelayPage.tsx`'s own design intent is that Switch/
  // Disconnect stay offered in exactly that case, so the student can
  // retry or clean up.
  it("a child that is unresponsive but whose session is kept still offers Switch/Disconnect", () => {
    const child = device(4, {
      name: "vevav",
      links: [
        link("usb-relay-1-via-vevav", {
          transport: "radio",
          state: "unresponsive",
          reason: "no reply from vevav",
          session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null },
          via: { relayLinkId: "usb-relay-1", relayName: "rly01", channel: 55, group: 114, addressSource: "derived" },
        }),
      ],
    });
    const el = mount(withRouter(<DevicesList status="open" devices={[relayDevice(), child]} unassigned={[]} />));
    const quick = el.querySelector('[data-testid="relay-quick-connect-3"]');
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

  // Sprint 016 ticket 004 (SUC-004): idle/sweeping rendering, mirroring
  // RelayPage.tsx's own identical label.
  it("renders 'idle' when relays[] reports lease: null and no bridging", () => {
    const relays: SnapshotRelay[] = [{ linkId: "usb-relay-1", lease: null }];
    const el = mount(withRouter(<DevicesList status="open" devices={[relayDevice()]} unassigned={[]} relays={relays} />));
    expect(el.querySelector('[data-testid="relay-quick-idle-3"]')?.textContent).toBe("idle");
  });

  it("renders 'idle' when the snapshot has no relays[] entry for this relay at all", () => {
    const el = mount(withRouter(<DevicesList status="open" devices={[relayDevice()]} unassigned={[]} />));
    expect(el.querySelector('[data-testid="relay-quick-idle-3"]')?.textContent).toBe("idle");
  });

  it("renders 'idle · sweeping' (no name known) when relays[] reports lease: 'sweep' and no candidate can be inferred", () => {
    const relays: SnapshotRelay[] = [{ linkId: "usb-relay-1", lease: "sweep" }];
    const el = mount(withRouter(<DevicesList status="open" devices={[relayDevice()]} unassigned={[]} relays={relays} />));
    expect(el.querySelector('[data-testid="relay-quick-idle-3"]')?.textContent).toBe("idle · sweeping");
  });

  it("renders 'idle · sweeping <name>' when a recently-sighted candidate can be inferred from lastChecked, and does NOT mistake that sighting for a live child", () => {
    const recentlyChecked = Date.now() - 5000;
    const swept = device(5, {
      name: "vevav",
      lastChecked: recentlyChecked,
      links: [
        link("radio-vevav-via-usb-relay-1", {
          transport: "radio",
          state: "connectable",
          via: { relayLinkId: "usb-relay-1", relayName: "rly01", channel: 41, group: 3, addressSource: "derived" },
        }),
      ],
    });
    const relays: SnapshotRelay[] = [{ linkId: "usb-relay-1", lease: "sweep" }];
    const el = mount(withRouter(<DevicesList status="open" devices={[relayDevice(), swept]} unassigned={[]} relays={relays} />));
    expect(el.querySelector('[data-testid="relay-quick-idle-3"]')?.textContent).toBe("idle · sweeping vevav");
    expect(el.querySelector('[data-testid="relay-quick-lost-3"]')).toBeNull();
  });

  it("ticket 016-007: renders 'idle · sweeping (fast)' once the sweeper has detected the relay's non-persisting-tune capability", () => {
    const relays: SnapshotRelay[] = [{ linkId: "usb-relay-1", lease: "sweep", sweep: { rate: "fast" } }];
    const el = mount(withRouter(<DevicesList status="open" devices={[relayDevice()]} unassigned={[]} relays={relays} />));
    expect(el.querySelector('[data-testid="relay-quick-idle-3"]')?.textContent).toBe("idle · sweeping (fast)");
  });

  it("ticket 016-007: renders 'idle · sweeping (slow)' once a sync has completed and found no capability advertised", () => {
    const relays: SnapshotRelay[] = [{ linkId: "usb-relay-1", lease: "sweep", sweep: { rate: "slow" } }];
    const el = mount(withRouter(<DevicesList status="open" devices={[relayDevice()]} unassigned={[]} relays={relays} />));
    expect(el.querySelector('[data-testid="relay-quick-idle-3"]')?.textContent).toBe("idle · sweeping (slow)");
  });

  it("a device carrying a 'last checked' timestamp on its via-linked radio row renders it in the device card's own connection list", () => {
    const at = Date.now() - 60_000;
    const swept = device(5, {
      name: "vevav",
      lastChecked: at,
      links: [
        link("radio-vevav-via-usb-relay-1", {
          transport: "radio",
          state: "connectable",
          via: { relayLinkId: "usb-relay-1", relayName: "rly01", channel: 41, group: 3, addressSource: "derived" },
        }),
      ],
    });
    const el = mount(withRouter(<DevicesList status="open" devices={[relayDevice(), swept]} unassigned={[]} />));
    const row = el.querySelector('[data-testid="device-link-lastchecked-radio-vevav-via-usb-relay-1"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("Last checked");
    expect(row?.textContent).toContain(new Date(at).toLocaleString());
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

  // Ticket 017-010 (team-lead bench evidence, 2026-09-13): the relay
  // quick-connect picker listed "tovez" twice -- two `kind: "robot"`
  // device rows sharing one name (the unmerged known-robots.json
  // placeholder plus its real, SWD-named row) each contributed their own
  // name to `robotOptions`. `FrontPage` now de-dupes by name before
  // handing the list to the picker.
  it("de-duplicates a robot name that currently has two device rows (an unmerged placeholder + its real row)", () => {
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
      socket!.emitMessage(
        snapshot({
          devices: [
            relayDevice(),
            device(2314287040, { name: "tovez", kind: "robot", links: [link("usb-tovez")] }),
            device(2665, { name: "tovez", kind: "robot", links: [] }),
          ],
        }),
      );
    });
    const select = el.querySelector<HTMLSelectElement>('[data-testid="relay-quick-connect-select-3"]');
    expect(Array.from(select!.options).map((o) => o.textContent)).toEqual(["Choose a robot…", "tovez"]);
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
