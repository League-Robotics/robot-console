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
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Snapshot, SnapshotDevice, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { DevicesList, FrontPage, RadioMigrationOffers } from "./FrontPage";
import { allocateRadioBridge } from "../deviceDisplay";
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

  it("colours the robot's name green only when some link is connected AND has answered, yellow otherwise (ticket 018-010; stakeholder 2026-09-14)", () => {
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
    expect(linked.querySelector('[data-testid="device-name-1"]')?.getAttribute("data-linked")).toBe("true");
    expect(linked.querySelector(".device-linked-pill")).toBeNull();

    if (root) act(() => root!.unmount());
    if (container) container.remove();

    const notLinked = mount(withRouter(<DevicesList status="open" devices={[device(1, { links: [link("usb-1", { state: "connectable" })] })]} unassigned={[]} />));
    expect(notLinked.querySelector('[data-testid="device-name-1"]')?.getAttribute("data-linked")).toBe("false");
  });

  // Ticket 018-010 bench defect: `vevov`'s mbserial bridge accepted a
  // TCP connection and flipped its link to `connected` while its own
  // robot never once replied to `HELLO` -- the pill must not show for
  // merely `state === "connected"` with no session, or a session that
  // has never answered.
  it("keeps the name yellow for a connected link that has no session, or a session that has never answered", () => {
    const noSession = mount(withRouter(<DevicesList status="open" devices={[device(1, { links: [link("usb-1", { state: "connected" })] })]} unassigned={[]} />));
    expect(noSession.querySelector('[data-testid="device-name-1"]')?.getAttribute("data-linked")).toBe("false");

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
    expect(neverAnswered.querySelector('[data-testid="device-name-1"]')?.getAttribute("data-linked")).toBe("false");
  });

  it("gives a radio bridge's name no link colour -- a bridge has no link of its own to show", () => {
    const el = mount(
      withRouter(
        <DevicesList
          status="open"
          devices={[device(7, { name: "vitut", kind: "relay", role: "RADIOBRIDGE", links: [link("usb-vitut", { state: "connectable" })] })]}
          unassigned={[]}
        />,
      ),
    );
    const name = el.querySelector('[data-testid="device-name-7"]');
    expect(name?.textContent).toBe("vitut");
    expect(name?.hasAttribute("data-linked")).toBe(false);
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
  it("stakeholder 2026-09-13/14: each live link is an icon chip that toggles its link; the failed chip carries the details in its popover", () => {
    const opens: string[] = [];
    const closes: string[] = [];
    const el = mount(
      withRouter(
        <DevicesList
          status="open"
          devices={[multiLinkDevice()]}
          unassigned={[]}
          sendable={true}
          onLinkConnect={(linkId) => opens.push(linkId)}
          onLinkClose={(linkId) => closes.push(linkId)}
        />,
      ),
    );
    const usbChip = el.querySelector('[data-testid="device-chip-usb-vevov"]');
    const wifiChip = el.querySelector('[data-testid="device-chip-wifi-vevov"]');
    expect(usbChip?.getAttribute("data-state")).toBe("linked");
    expect(usbChip?.querySelector("a")).toBeNull();
    expect(usbChip?.querySelector('svg[data-icon="usb"]')).not.toBeNull();
    expect(wifiChip?.getAttribute("data-state")).toBe("failed");
    expect(wifiChip?.querySelector('svg[data-icon="wifi"]')).not.toBeNull();
    expect(wifiChip?.querySelector(".device-chip-popover")?.textContent).toContain("Couldn't connect: could not reach vevov.local:7654");
    expect(el.querySelector('[data-testid="device-role-1"]')?.textContent).toBe("Role unknown");

    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="device-chip-toggle-usb-vevov"]')!.click();
    });
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="device-chip-toggle-wifi-vevov"]')!.click();
    });
    expect(closes).toEqual(["usb-vevov"]);
    expect(opens).toEqual(["wifi-vevov"]);
  });

  it("stakeholder 2026-09-13: the home page groups robots first, then radio bridges", () => {
    const relay = device(7, { name: "vitut", kind: "relay", role: "RADIOBRIDGE", links: [link("usb-vitut", { state: "connectable", transport: "usb" })] });
    const el = mount(withRouter(<DevicesList status="open" devices={[relay, multiLinkDevice()]} unassigned={[]} />));
    const groups = Array.from(el.querySelectorAll(".devices-group")).map((g) => g.getAttribute("data-testid"));
    expect(groups).toEqual(["devices-group-robots", "devices-group-bridges"]);
    expect(el.querySelector('[data-testid="devices-group-robots"] [data-testid="device-card-1"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="devices-group-bridges"] [data-testid="device-card-7"]')).not.toBeNull();
  });

  it("stakeholder 2026-09-14: the card's own arrow, into the usable (primary) link, is the only way in -- no link row carries an arrow or a Connect button", () => {
    const el = mount(withRouter(<DevicesList status="open" devices={[multiLinkDevice()]} unassigned={[]} sendable={true} />));

    expect(el.querySelectorAll("h3.device-name")).toHaveLength(1);
    expect(el.querySelector('[data-testid="device-open-1"]')?.getAttribute("href")).toBe("/d/usb-vevov");
    expect(el.querySelectorAll("a")).toHaveLength(1);

    // usb + wifi chips, plus the radio chip every robot carries.
    expect(el.querySelectorAll(".device-connections > li")).toHaveLength(3);
    const wifiRow = el.querySelector('[data-testid="device-link-wifi-vevov"]');
    expect(wifiRow?.textContent).toContain("WiFi · vevov.local:7654");
    expect(wifiRow?.textContent).toContain("Couldn't connect: could not reach vevov.local:7654");
    expect(el.querySelector('[data-testid="device-link-usb-vevov"]')?.textContent).toContain("Linked");
    expect(Array.from(el.querySelectorAll("button")).some((b) => b.textContent === "Connect")).toBe(false);
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

  it("shows each link's state text (with its reason in plain words folded in, once), and pressing the chip sends session-open", () => {
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
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="device-chip-toggle-usb-zapuz"]')!.click();
    });
    expect(opens).toEqual(["usb-zapuz"]);
  });

  it("a chip press sends nothing when sendable is false", () => {
    const opens: string[] = [];
    const el = mount(
      withRouter(
        <DevicesList
          status="open"
          devices={[device(1, { links: [link("usb-1", { state: "failed", reason: "boom" })] })]}
          unassigned={[]}
          sendable={false}
          onLinkConnect={(linkId) => opens.push(linkId)}
        />,
      ),
    );
    const toggle = el.querySelector<HTMLButtonElement>('[data-testid="device-chip-toggle-usb-1"]')!;
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    act(() => {
      toggle.click();
    });
    expect(opens).toEqual([]);
  });

  it("a chip press mid-connect sends nothing", () => {
    const sent: string[] = [];
    const el = mount(
      withRouter(
        <DevicesList
          status="open"
          devices={[device(1, { links: [link("usb-1", { state: "connecting" })] })]}
          unassigned={[]}
          onLinkConnect={(linkId) => sent.push(`open ${linkId}`)}
          onLinkClose={(linkId) => sent.push(`close ${linkId}`)}
        />,
      ),
    );
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="device-chip-toggle-usb-1"]')!.click();
    });
    expect(sent).toEqual([]);
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

  // Bench defect (team-lead walk 017-012, 2026-09-13): opening a relay
  // pool's own link is not a student action -- a bridge is used from a
  // robot's radio chip (stakeholder, 2026-09-14).
  it("a relay card's own chip toggles nothing", () => {
    const opens: string[] = [];
    const el = mount(
      withRouter(
        <DevicesList
          status="open"
          sendable={true}
          onLinkConnect={(linkId) => opens.push(linkId)}
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
    const toggle = el.querySelector<HTMLButtonElement>('[data-testid="device-chip-toggle-mbrelay-torture"]')!;
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    act(() => {
      toggle.click();
    });
    expect(opens).toEqual([]);
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

    const connect = el.querySelector<HTMLButtonElement>('[data-testid="device-chip-toggle-usb-tovez"]');
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

// Sprint 019 ticket 005 (SUC-005): an MCP-opened session shows up on this
// same per-link row exactly the way a browser-opened one already does,
// distinctly labeled with its own caller -- the stakeholder's own
// original ask for the whole MCP feature ("it shows up in the robot
// console"), not a gate.
describe("MCP-opened session origin/caller label (ticket 005)", () => {
  it("shows an 'Agent: <caller>' label for a session with origin 'mcp'", () => {
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
                  session: {
                    seq: 0,
                    pending: 0,
                    lastDone: null,
                    lastDoneReason: null,
                    robotStatus: null,
                    functions: null,
                    origin: "mcp",
                    caller: "agent-smith",
                  },
                }),
              ],
            }),
          ]}
          unassigned={[]}
        />,
      ),
    );
    const agentLabel = el.querySelector('[data-testid="device-link-agent-usb-vevov"]');
    expect(agentLabel?.textContent).toBe("Agent: agent-smith");
  });

  it("shows no agent label for an ordinary browser session (origin 'ui' or absent)", () => {
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
                  session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null, origin: "ui", caller: null },
                }),
              ],
            }),
          ]}
          unassigned={[]}
        />,
      ),
    );
    expect(el.querySelector('[data-testid="device-link-agent-usb-vevov"]')).toBeNull();
  });

  it("falls back to 'Agent: unknown' if an mcp-origin session somehow carries no caller name", () => {
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
                  session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null, origin: "mcp", caller: null },
                }),
              ],
            }),
          ]}
          unassigned={[]}
        />,
      ),
    );
    expect(el.querySelector('[data-testid="device-link-agent-usb-vevov"]')?.textContent).toBe("Agent: unknown");
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

  it("offers a Radio button beside Forget that tries the robot over a free bridge", () => {
    // Stakeholder, 2026-09-21: "the radio button in Not seen recently is
    // going to try to make radio contact with that robot, and if it
    // succeeds, then it moves it up to the top."
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
    const relay = device(7, {
      name: "vitut",
      kind: "relay",
      role: "RADIOBRIDGE",
      links: [link("usb-vitut", { state: "connectable", transport: "usb" })],
    });
    act(() => {
      socket!.emitMessage(snapshot({ devices: [relay, device(9, { name: "nuvek", links: [] })] }));
    });

    const radio = el.querySelector<HTMLButtonElement>('[data-testid="not-seen-radio-9"]');
    expect(radio).not.toBeNull();
    // The same radio symbol the robot cards use, not the word "Radio"
    // (stakeholder, 2026-09-21). An icon-only control carries its name
    // in `aria-label`, so that is what there is to assert.
    expect(radio!.querySelector("svg")).not.toBeNull();
    expect(radio!.textContent).toBe("");
    expect(radio!.getAttribute("aria-label")).toBe("Try nuvek over radio");
    act(() => {
      radio!.click();
    });

    // Exactly the message the robot cards' own radio chip sends, so
    // there is one way to open a radio session, not two.
    expect(socket!.sent).toContain(JSON.stringify({ type: "session-open", relayLinkId: "usb-vitut", name: "nuvek" }));
    expect(el.querySelector('[data-testid="not-seen-radio-9"]')!.getAttribute("data-state")).toBe("busy");
    expect(el.querySelector('[data-testid="not-seen-radio-problem-9"]')?.textContent).toBe("Trying…");
  });

  it("holds the card down until contact is made, then lets it move up", () => {
    // Stakeholder, 2026-09-21: "they shouldn't move up to the top as
    // soon as you click the radio button. You should try to make
    // contact first... if it connects and goes green, then you put it
    // in the top section. If you can't connect to it? Leave it down
    // below." Clicking produces a `connecting` link almost at once, and
    // `cardLinks` counts that -- so without the hold the card jumped up
    // on the click rather than on the answer.
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
    const relay = device(7, {
      name: "vitut",
      kind: "relay",
      role: "RADIOBRIDGE",
      links: [link("usb-vitut", { state: "connectable", transport: "usb" })],
    });
    act(() => {
      socket!.emitMessage(snapshot({ devices: [relay, device(9, { name: "nuvek", links: [] })] }));
    });
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="not-seen-radio-9"]')!.click();
    });

    // The host answers with a link that is merely CONNECTING. Not
    // contact -- stay put, and stay yellow.
    const connecting = device(9, { name: "nuvek", links: [link("radio-nuvek", { transport: "radio", state: "connecting" })] });
    act(() => {
      socket!.emitMessage(snapshot({ devices: [relay, connecting] }));
    });
    expect(el.querySelector('[data-testid="not-seen-device-9"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="not-seen-radio-9"]')!.getAttribute("data-state")).toBe("busy");

    // Contact. `isLinkUsable` is state `connected` AND a live session --
    // the same test the radio chip up top uses to call itself linked.
    // `isLinkUsable` needs a live SESSION as well as `connected` -- a
    // connected link with no session is a bridge that answered, not a
    // robot that did.
    const linked = device(9, {
      name: "nuvek",
      links: [
        link("radio-nuvek", {
          transport: "radio",
          state: "connected",
          session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null },
        }),
      ],
    });
    act(() => {
      socket!.emitMessage(snapshot({ devices: [relay, linked] }));
    });
    expect(el.querySelector('[data-testid="not-seen-device-9"]')).toBeNull();
    expect(el.querySelector('[data-testid="device-card-9"]') ?? el.querySelector('[data-testid="device-radio-chip-9"]')).not.toBeNull();
  });

  it("leaves a robot that never answers down below, not stranded up top", () => {
    vi.useFakeTimers();
    try {
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
      const relay = device(7, {
        name: "vitut",
        kind: "relay",
        role: "RADIOBRIDGE",
        links: [link("usb-vitut", { state: "connectable", transport: "usb" })],
      });
      act(() => {
        socket!.emitMessage(snapshot({ devices: [relay, device(9, { name: "nuvek", links: [] })] }));
      });
      act(() => {
        el.querySelector<HTMLButtonElement>('[data-testid="not-seen-radio-9"]')!.click();
      });
      const connecting = device(9, { name: "nuvek", links: [link("radio-nuvek", { transport: "radio", state: "connecting" })] });
      act(() => {
        socket!.emitMessage(snapshot({ devices: [relay, connecting] }));
      });

      act(() => {
        vi.advanceTimersByTime(61_000);
      });
      // Still here, back to white, and saying why.
      expect(el.querySelector('[data-testid="not-seen-device-9"]')).not.toBeNull();
      expect(el.querySelector('[data-testid="not-seen-radio-9"]')!.getAttribute("data-state")).toBe("idle");
      expect(el.querySelector('[data-testid="not-seen-radio-problem-9"]')?.textContent).toBe("No answer over radio");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says so, and sends nothing, when no radio bridge is free", () => {
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
    // No relay in the snapshot at all -- nothing to allocate.
    act(() => {
      socket!.emitMessage(snapshot({ devices: [device(9, { name: "nuvek", links: [] })] }));
    });
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="not-seen-radio-9"]')!.click();
    });
    expect(el.querySelector('[data-testid="not-seen-radio-problem-9"]')?.textContent).toBe("No radio bridge is free");
    expect(socket!.sent).toEqual([]);
    // Still offering to try, not stuck on "Trying…" for an attempt that
    // never left the building.
    expect(el.querySelector('[data-testid="not-seen-radio-9"]')!.getAttribute("data-state")).toBe("idle");
  });

  it("stops saying 'Trying…' when the bridge never answers", () => {
    vi.useFakeTimers();
    try {
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
      const relay = device(7, {
        name: "vitut",
        kind: "relay",
        role: "RADIOBRIDGE",
        links: [link("usb-vitut", { state: "connectable", transport: "usb" })],
      });
      act(() => {
        socket!.emitMessage(snapshot({ devices: [relay, device(9, { name: "nuvek", links: [] })] }));
      });
      act(() => {
        el.querySelector<HTMLButtonElement>('[data-testid="not-seen-radio-9"]')!.click();
      });
      expect(el.querySelector('[data-testid="not-seen-radio-9"]')!.getAttribute("data-state")).toBe("busy");

      act(() => {
        vi.advanceTimersByTime(61_000);
      });
      expect(el.querySelector('[data-testid="not-seen-radio-9"]')!.getAttribute("data-state")).toBe("idle");
      expect(el.querySelector('[data-testid="not-seen-radio-problem-9"]')?.textContent).toBe("No answer over radio");
    } finally {
      vi.useRealTimers();
    }
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

describe("radio chip and radio bridge cards (stakeholder, 2026-09-14)", () => {
  const SESSION = { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null, answeredAt: Date.now() };

  function usbBridge(id: number, name: string, overrides: Partial<SnapshotLink> = {}): SnapshotDevice {
    return device(id, { name, kind: "relay", role: "RADIOBRIDGE", links: [link(`usb-${name}`, { state: "connectable", ...overrides })] });
  }

  function pool(id: number, name: string): SnapshotDevice {
    return device(id, {
      name,
      kind: "relay",
      links: [link(`mbrelay-${name}`, { transport: "mbrelay", label: `mbrelay · ${name}.local:8760`, state: "connectable" })],
    });
  }

  function radioLink(robot: string, relayLinkId: string, relayName: string, overrides: Partial<SnapshotLink> = {}): SnapshotLink {
    return link(`radio-${robot}-via-${relayLinkId}`, {
      transport: "radio",
      label: "Radio · ch1/grp1",
      state: "connectable",
      via: { relayLinkId, relayName, channel: 1, group: 1, addressSource: "derived" },
      ...overrides,
    });
  }

  function chipState(el: Element, deviceId: number): string | null | undefined {
    return el.querySelector(`[data-testid="device-radio-chip-${deviceId}"]`)?.getAttribute("data-state");
  }

  function pressRadio(el: Element, deviceId: number): void {
    act(() => {
      el.querySelector<HTMLButtonElement>(`[data-testid="device-radio-toggle-${deviceId}"]`)!.click();
    });
  }

  it("allocateRadioBridge picks a free USB radio bridge first, then an mbrelay pool, else nothing", () => {
    const bridged = device(10, { name: "gopiv", links: [radioLink("gopiv", "usb-vevav", "vevav", { state: "connected", session: SESSION })] });
    expect(allocateRadioBridge([pool(1, "torture"), usbBridge(2, "vevav")])).toBe("usb-vevav");
    expect(allocateRadioBridge([pool(1, "torture"), usbBridge(2, "vevav"), bridged])).toBe("mbrelay-torture");
    expect(allocateRadioBridge([usbBridge(2, "vevav"), bridged])).toBeUndefined();
    expect(allocateRadioBridge([usbBridge(2, "vevav", { state: "failed" })])).toBeUndefined();
    expect(allocateRadioBridge([])).toBeUndefined();
  });

  it("every robot card carries a yellow radio chip, with no radio link needed; a bridge card carries none", () => {
    const el = mount(withRouter(<DevicesList status="open" devices={[device(1, { name: "tovez" }), usbBridge(2, "vevav")]} unassigned={[]} />));
    expect(chipState(el, 1)).toBe("idle");
    expect(el.querySelector('[data-testid="device-radio-chip-2"]')).toBeNull();
  });

  it("folds a robot's radio links into its radio chip: green once bridged, and pressing it closes that link", () => {
    const closes: string[] = [];
    const robot = device(1, {
      name: "gopiv",
      links: [link("usb-gopiv", { state: "connectable" }), radioLink("gopiv", "usb-vevav", "vevav", { state: "connected", session: SESSION })],
    });
    const el = mount(
      withRouter(<DevicesList status="open" devices={[robot, usbBridge(2, "vevav")]} unassigned={[]} onLinkClose={(linkId) => closes.push(linkId)} />),
    );
    expect(el.querySelector('[data-testid="device-chip-radio-gopiv-via-usb-vevav"]')).toBeNull();
    expect(chipState(el, 1)).toBe("linked");
    expect(el.querySelector('[data-testid="device-radio-chip-1"]')?.textContent).toContain("Radio via vevav");
    pressRadio(el, 1);
    expect(closes).toEqual(["radio-gopiv-via-usb-vevav"]);
  });

  it("FrontPage: pressing a yellow radio chip bridges through a free USB bridge before the mbrelay pool, goes busy, then green", () => {
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
      socket!.emitMessage(snapshot({ devices: [device(1, { name: "gopiv" }), pool(2, "torture"), usbBridge(3, "vevav")] }));
    });

    pressRadio(el, 1);
    expect(socket!.sent).toContainEqual(JSON.stringify({ type: "session-open", relayLinkId: "usb-vevav", name: "gopiv" }));
    expect(chipState(el, 1)).toBe("busy");

    act(() => {
      socket!.emitMessage(
        snapshot({
          seq: 2,
          devices: [
            device(1, { name: "gopiv", links: [link("usb-1"), radioLink("gopiv", "usb-vevav", "vevav", { state: "connected", session: SESSION })] }),
            pool(2, "torture"),
            usbBridge(3, "vevav"),
          ],
        }),
      );
    });
    expect(chipState(el, 1)).toBe("linked");
    expect(el.querySelector('[data-testid="relay-connections-3"]')?.textContent).toBe("Connected to gopiv");
  });

  it("FrontPage: with the USB bridge already carrying a robot, the next radio chip goes to the mbrelay pool", () => {
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
            device(1, { name: "gopiv", links: [link("usb-1"), radioLink("gopiv", "usb-vevav", "vevav", { state: "connected", session: SESSION })] }),
            device(4, { name: "tovez" }),
            pool(2, "torture"),
            usbBridge(3, "vevav"),
          ],
        }),
      );
    });
    pressRadio(el, 4);
    expect(socket!.sent).toContainEqual(JSON.stringify({ type: "session-open", relayLinkId: "mbrelay-torture", name: "tovez" }));
  });

  it("a radio chip with no free bridge flashes red, sends nothing, then settles back to yellow with the reason in its popover", () => {
    const connects: Array<[string, string]> = [];
    const el = mount(
      withRouter(<DevicesList status="open" devices={[device(1, { name: "gopiv" })]} unassigned={[]} onRadioConnect={(relayLinkId, name) => connects.push([relayLinkId, name])} />),
    );
    vi.useFakeTimers();
    try {
      pressRadio(el, 1);
      expect(connects).toEqual([]);
      expect(chipState(el, 1)).toBe("flash");
      act(() => {
        vi.advanceTimersByTime(1300);
      });
      expect(chipState(el, 1)).toBe("idle");
      expect(el.querySelector('[data-testid="device-radio-state-1"]')?.textContent).toBe("Couldn't connect: no radio bridge is free");
    } finally {
      vi.useRealTimers();
    }
  });

  it("FrontPage: a bridge that fails flashes the radio chip red, then back to yellow with the failure in its popover", () => {
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
      socket!.emitMessage(snapshot({ devices: [device(1, { name: "gopiv" }), usbBridge(3, "vevav")] }));
    });
    vi.useFakeTimers();
    try {
      pressRadio(el, 1);
      expect(chipState(el, 1)).toBe("busy");
      act(() => {
        socket!.emitMessage(
          snapshot({
            seq: 2,
            devices: [
              device(1, {
                name: "gopiv",
                links: [
                  link("usb-1"),
                  radioLink("gopiv", "usb-vevav", "vevav", {
                    state: "failed",
                    since: 5000,
                    reason: 'relayBridger: candidate "radio-gopiv-via-usb-vevav" produced no banner within the identify budget',
                  }),
                ],
              }),
              usbBridge(3, "vevav"),
            ],
          }),
        );
      });
      expect(chipState(el, 1)).toBe("flash");
      act(() => {
        vi.advanceTimersByTime(1300);
      });
      expect(chipState(el, 1)).toBe("idle");
      expect(el.querySelector('[data-testid="device-radio-state-1"]')?.textContent).toBe(
        "Couldn't connect: no radio reply — is the robot on and in range?",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("a USB radio bridge card reads 'Unconnected', with no robot picker; an idle mbrelay pool card shows nothing", () => {
    const el = mount(withRouter(<DevicesList status="open" devices={[usbBridge(2, "vevav"), pool(3, "torture")]} unassigned={[]} />));
    expect(el.querySelector('[data-testid="relay-connections-2"]')?.textContent).toBe("Unconnected");
    expect(el.querySelector('[data-testid="relay-connections-3"]')).toBeNull();
    expect(el.querySelector("select")).toBeNull();
  });

  it("an mbrelay pool card lists one line per robot this console has bridged through it", () => {
    const el = mount(
      withRouter(
        <DevicesList
          status="open"
          devices={[
            device(1, {
              name: "gopiv",
              links: [link("usb-1"), radioLink("gopiv", "mbrelay-torture", "torture", { transport: "mbrelay", state: "connected", session: SESSION })],
            }),
            device(4, { name: "tovez", links: [link("usb-4"), radioLink("tovez", "mbrelay-torture", "torture", { transport: "mbrelay", state: "connecting" })] }),
            device(5, { name: "tigez", links: [link("usb-5"), radioLink("tigez", "mbrelay-torture", "torture", { transport: "mbrelay", state: "failed" })] }),
            pool(3, "torture"),
          ]}
          unassigned={[]}
        />,
      ),
    );
    const lines = Array.from(el.querySelectorAll('[data-testid="relay-connections-3"] li')).map((li) => li.textContent);
    expect(lines).toEqual(["Connected to gopiv", "Connecting to tovez…"]);
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

describe("no console dock on the device list (sprint 022 ticket 003, SUC-001)", () => {
  // `ConsoleDock` mounts from `DevicePage.tsx` only (sprint 022 ticket
  // 002's own doc comment) -- `FrontPage` is never in `DevicePage`'s
  // subtree, so "no dock (not even collapsed) renders on `/`" needs no
  // guard of its own here, only this assertion that it stays true.
  // `withRouter`'s default `initialEntries` is already `["/"]`.
  it("renders no dock-related element, collapsed or open, on the front page", () => {
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
      socket!.emitMessage(snapshot({ devices: [device(1, { name: "tigez" })] }));
    });

    expect(el.querySelector('[data-testid="console-dock"]')).toBeNull();
    expect(el.querySelector('[data-testid="console-dock-toggle"]')).toBeNull();
    expect(el.querySelector('[data-testid="console-dock-pane"]')).toBeNull();
  });
});
