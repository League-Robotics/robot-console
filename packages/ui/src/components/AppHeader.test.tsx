// @vitest-environment jsdom
/**
 * AppHeader.test.tsx — component-level tests for the route-aware app
 * header, migrated to sprint 015's `Snapshot` contract (ticket 007).
 *
 * Covers the back-to-devices link across `/` and the `/d/:linkId`
 * states, the `RadioAddressDialog` call site resolving its device via
 * `useDeviceForLink` and passing the `{deviceId, name, radio}` props
 * that component has taken since ticket 006 (ticket 007), and (ticket
 * 008) the restored Flash/Set Wi-Fi entries: Flash offered for *any*
 * resolvable link (owned or not, `forceShow`), Set Wi-Fi gated the same
 * way Set Radio is (a real device, not a relay).
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Snapshot, SnapshotDevice, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { AppHeader } from "./AppHeader";
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
});

function device(
  overrides: Partial<Omit<SnapshotDevice, "links">> & { links?: SnapshotDevice["links"] } = {},
): SnapshotDevice {
  const { links, ...rest } = overrides;
  return {
    id: 1,
    name: "zeguz",
    kind: "robot",
    role: null,
    commonName: null,
    program: null,
    version: null,
    owned: true,
    radio: { channel: 1, group: 1, source: "derived" },
    lastSeen: 0,
    lastChecked: null,
    links: links ?? [
      {
        id: "usb-SERIAL-A",
        transport: "usb",
        label: "USB · /dev/cu.usbmodemA",
        state: "connectable",
        reason: null,
        since: 0,
        lastSeen: 0,
        nextRetryAt: null,
        capabilities: { open: true, close: false, flash: true, provisionWifi: false },
      },
    ],
    ...rest,
  };
}

function snapshot(devices: SnapshotDevice[], hostVersion?: string, unassigned: SnapshotLink[] = []): Snapshot {
  return {
    type: "snapshot",
    seq: 1,
    at: 0,
    ...(hostVersion !== undefined ? { hostVersion } : {}),
    devices,
    unassigned,
    relays: [],
    firmware: { relay: { configured: false }, robot: { configured: false }, joystick: { configured: false } },
    wifi: { ssid: null, source: null },
    tasks: [],
  };
}

function mountAt(
  initialPath: string,
  options: { devices?: SnapshotDevice[]; unassigned?: SnapshotLink[] } = {},
): { el: HTMLDivElement; socket: () => FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    withRouter(
      <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
        <AppHeader />
      </WsProvider>,
      { initialEntries: [initialPath] },
    ),
  );
  act(() => {
    socket!.emitOpen();
  });
  if (options.devices || options.unassigned) {
    act(() => {
      socket!.emitMessage(snapshot(options.devices ?? [], undefined, options.unassigned ?? []));
    });
  }
  return { el, socket: () => socket! };
}

function backLink(el: HTMLDivElement): HTMLAnchorElement | null {
  return el.querySelector("a");
}

describe("AppHeader back-to-devices link", () => {
  it("renders no back link on /", () => {
    const { el } = mountAt("/");
    expect(backLink(el)).toBeNull();
  });

  it("renders exactly one back link, with an accessible name, in the loading state (!hasSnapshot)", () => {
    const { el } = mountAt("/d/usb-SERIAL-A");
    const links = el.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/");
    expect(links[0]?.getAttribute("aria-label")).toBe("Back to devices");
    expect(links[0]?.querySelector("svg")).not.toBeNull();
  });

  it("renders exactly one back link when no device owns the routed link id", () => {
    const { el } = mountAt("/d/usb-MISSING", { devices: [device()] });
    const links = el.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/");
  });

  it("renders exactly one back link on a relay device page", () => {
    const { el } = mountAt("/d/usb-RELAY-A", {
      devices: [
        device({
          id: 2,
          kind: "relay",
          role: "RADIOBRIDGE",
          links: [
            {
              id: "usb-RELAY-A",
              transport: "usb",
              label: "USB · relay",
              state: "connected",
              reason: null,
              since: 0,
              lastSeen: 0,
              nextRetryAt: null,
              capabilities: { open: false, close: true, flash: true, provisionWifi: false },
            },
          ],
        }),
      ],
    });
    const links = el.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/");
  });
});

describe("AppHeader Set Radio (sprint 015 ticket 007)", () => {
  it("shows no Set Radio trigger on / or in the loading state", () => {
    expect(mountAt("/").el.querySelector('[data-testid="radio-address-trigger"]')).toBeNull();
    expect(mountAt("/d/usb-SERIAL-A").el.querySelector('[data-testid="radio-address-trigger"]')).toBeNull();
  });

  it("shows no Set Radio trigger when no device owns the routed link id", () => {
    const { el } = mountAt("/d/usb-MISSING", { devices: [device()] });
    expect(el.querySelector('[data-testid="radio-address-trigger"]')).toBeNull();
  });

  it("shows Set Radio for a robot device page, passing the resolved deviceId/name/radio through to the dialog", () => {
    const { el } = mountAt("/d/usb-SERIAL-A", {
      devices: [device({ id: 42, name: "tigez", radio: { channel: 55, group: 114, source: "override" } })],
    });
    const trigger = el.querySelector<HTMLButtonElement>('[data-testid="radio-address-trigger"]');
    expect(trigger).not.toBeNull();
    act(() => {
      trigger!.click();
    });
    expect(el.querySelector("h2")?.textContent).toBe("Radio address for tigez");
    expect(el.querySelector<HTMLInputElement>('[data-testid="radio-channel"]')!.value).toBe("55");
    expect(el.querySelector<HTMLInputElement>('[data-testid="radio-group"]')!.value).toBe("114");
  });

  it("shows no Set Radio trigger for a relay device page", () => {
    const { el } = mountAt("/d/usb-RELAY-A", {
      devices: [
        device({
          id: 2,
          kind: "relay",
          links: [
            {
              id: "usb-RELAY-A",
              transport: "usb",
              label: "USB · relay",
              state: "connected",
              reason: null,
              since: 0,
              lastSeen: 0,
              nextRetryAt: null,
              capabilities: { open: false, close: true, flash: true, provisionWifi: false },
            },
          ],
        }),
      ],
    });
    expect(el.querySelector('[data-testid="radio-address-trigger"]')).toBeNull();
  });
});

function flashTrigger(el: HTMLDivElement): HTMLButtonElement | undefined {
  return Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Flash");
}

describe("AppHeader Flash (sprint 015 ticket 008 restore)", () => {
  it("shows no Flash trigger on / or in the loading state", () => {
    expect(flashTrigger(mountAt("/").el)).toBeUndefined();
    expect(flashTrigger(mountAt("/d/usb-SERIAL-A").el)).toBeUndefined();
  });

  it("shows no Flash trigger when no link at all matches the routed id", () => {
    const { el } = mountAt("/d/usb-MISSING", { devices: [device()] });
    expect(flashTrigger(el)).toBeUndefined();
  });

  it("offers a Flash trigger for an identified robot device (forceShow bypasses canBeFlashed)", () => {
    const { el } = mountAt("/d/usb-SERIAL-A", {
      devices: [
        device({
          role: "NEZHA2",
          links: [
            {
              id: "usb-SERIAL-A",
              transport: "usb",
              label: "USB · /dev/cu.usbmodemA",
              state: "connected",
              reason: null,
              since: 0,
              lastSeen: 0,
              nextRetryAt: null,
              capabilities: { open: false, close: true, flash: false, provisionWifi: true },
            },
          ],
        }),
      ],
    });
    expect(flashTrigger(el)).not.toBeUndefined();
  });

  it("offers a Flash trigger for a relay device too -- Flash is not gated on kind", () => {
    const { el } = mountAt("/d/usb-RELAY-A", {
      devices: [
        device({
          id: 2,
          kind: "relay",
          links: [
            {
              id: "usb-RELAY-A",
              transport: "usb",
              label: "USB · relay",
              state: "connected",
              reason: null,
              since: 0,
              lastSeen: 0,
              nextRetryAt: null,
              capabilities: { open: false, close: true, flash: true, provisionWifi: false },
            },
          ],
        }),
      ],
    });
    expect(flashTrigger(el)).not.toBeUndefined();
  });

  it("shows the reflash warning for an identified device opened via the header's forceShow", () => {
    const { el } = mountAt("/d/usb-SERIAL-A", {
      devices: [
        device({
          name: "tigez",
          role: "NEZHA2",
          links: [
            {
              id: "usb-SERIAL-A",
              transport: "usb",
              label: "USB · /dev/cu.usbmodemA",
              state: "connected",
              reason: null,
              since: 0,
              lastSeen: 0,
              nextRetryAt: null,
              capabilities: { open: false, close: true, flash: false, provisionWifi: true },
            },
          ],
        }),
      ],
    });
    act(() => {
      flashTrigger(el)!.click();
    });
    expect(el.textContent).toContain('Reflashing "tigez" will interrupt whatever it\'s currently running.');
  });
});

describe("AppHeader Flash / Set Wi-Fi send-gating (ticket 011, carried from 009)", () => {
  it("disables both the Flash and Set Wi-Fi triggers once the socket closes, and re-enables them once reconnected with a fresh snapshot", () => {
    const robotDevice = device({
      id: 42,
      name: "tigez",
      role: "NEZHA2",
      links: [
        {
          id: "usb-SERIAL-A",
          transport: "usb",
          label: "USB · /dev/cu.usbmodemA",
          state: "connected",
          reason: null,
          since: 0,
          lastSeen: 0,
          nextRetryAt: null,
          capabilities: { open: false, close: true, flash: false, provisionWifi: true },
        },
      ],
    });
    const { el, socket } = mountAt("/d/usb-SERIAL-A", { devices: [robotDevice] });

    expect(flashTrigger(el)!.disabled).toBe(false);
    expect(el.querySelector<HTMLButtonElement>('[data-testid="wifi-credentials-trigger"]')!.disabled).toBe(false);

    act(() => {
      socket().close();
    });
    expect(flashTrigger(el)!.disabled).toBe(true);
    expect(el.querySelector<HTMLButtonElement>('[data-testid="wifi-credentials-trigger"]')!.disabled).toBe(true);

    act(() => {
      socket().emitOpen();
    });
    // Reconnected but stale (no fresh snapshot yet) -- still disabled.
    expect(flashTrigger(el)!.disabled).toBe(true);
    expect(el.querySelector<HTMLButtonElement>('[data-testid="wifi-credentials-trigger"]')!.disabled).toBe(true);

    act(() => {
      socket().emitMessage(snapshot([robotDevice]));
    });
    expect(flashTrigger(el)!.disabled).toBe(false);
    expect(el.querySelector<HTMLButtonElement>('[data-testid="wifi-credentials-trigger"]')!.disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Ticket 017-011 (+ extended scope, team-lead 2026-09-13, item C):
// connection label + state under the name/back-link row, Connect when
// not usable, "Use <label> instead" to a usable sibling link.
// ---------------------------------------------------------------------

// Ticket 018-010: `linkStateText`'s "connected" case now reads "Linked"
// only once the session has actually answered (`isLinkAnswering`), not
// merely `state === "connected"` -- this fixture's own uses all mean to
// exercise the header's "Linked" text, so it needs a fresh `answeredAt`
// too, matching a session that has genuinely replied.
const OPEN_SESSION = { seq: 3, pending: 0, lastDone: 3, lastDoneReason: "none", robotStatus: null, functions: null, answeredAt: Date.now() };

function connectionText(el: HTMLDivElement): string | undefined {
  return el.querySelector('[data-testid="app-header-connection"]')?.textContent ?? undefined;
}

describe("AppHeader connection label + state (ticket 017-011)", () => {
  it("a USB link with an open session shows its connection label and 'Linked'", () => {
    const { el } = mountAt("/d/usb-SERIAL-A", {
      devices: [
        device({
          links: [
            {
              id: "usb-SERIAL-A",
              transport: "usb",
              label: "USB · /dev/cu.usbmodemA",
              state: "connected",
              reason: null,
              since: 0,
              lastSeen: 0,
              nextRetryAt: null,
              session: OPEN_SESSION,
              capabilities: { open: false, close: true, flash: true, provisionWifi: true },
            },
          ],
        }),
      ],
    });
    expect(el.querySelector('[data-testid="app-header-connection-state"]')?.textContent).toBe("Linked");
    expect(el.querySelector('[data-testid="app-header-connection"]')?.textContent).toContain("USB · /dev/cu.usbmodemA");
    expect(el.querySelector('[data-testid="app-header-not-usable"]')).toBeNull();
    expect(el.querySelector('[data-testid="app-header-connect"]')).toBeNull();
  });

  it("an mbserial link with an open session shows its connection label and 'Linked'", () => {
    const { el } = mountAt("/d/mbserial-gopiv", {
      devices: [
        device({
          links: [
            {
              id: "mbserial-gopiv",
              transport: "mbserial",
              label: "mbserial · gopiv",
              state: "connected",
              reason: null,
              since: 0,
              lastSeen: 0,
              nextRetryAt: null,
              session: OPEN_SESSION,
              capabilities: { open: true, close: true, flash: false, provisionWifi: true },
            },
          ],
        }),
      ],
    });
    expect(connectionText(el)).toContain("mbserial · gopiv");
    expect(el.querySelector('[data-testid="app-header-connection-state"]')?.textContent).toBe("Linked");
  });

  it("a via-relay (radio) link with an open session shows its 'via relay' label and 'Linked'", () => {
    const { el } = mountAt("/d/radio-gopiv-via-torture", {
      devices: [
        device({
          links: [
            {
              id: "radio-gopiv-via-torture",
              transport: "radio",
              label: "Radio · ch47/grp60",
              state: "connected",
              reason: null,
              since: 0,
              lastSeen: 0,
              nextRetryAt: null,
              session: OPEN_SESSION,
              via: { relayLinkId: "mbrelay-torture", relayName: "torture", channel: 47, group: 60, addressSource: "derived" },
              capabilities: { open: true, close: true, flash: false, provisionWifi: false },
            },
          ],
        }),
      ],
    });
    expect(connectionText(el)).toContain("Radio · ch47/grp60 (via relay torture)");
    expect(el.querySelector('[data-testid="app-header-connection-state"]')?.textContent).toBe("Linked");
  });

  it("a link with no open session shows plain 'Not connected' plus a Connect button that sends session-open, gated by useSendable (018-010: the stakeholder rejected the old 'No open session on this link' wording)", () => {
    const { el, socket } = mountAt("/d/usb-SERIAL-A", {
      devices: [
        device({
          links: [
            {
              id: "usb-SERIAL-A",
              transport: "usb",
              label: "USB · /dev/cu.usbmodemA",
              state: "connectable",
              reason: null,
              since: 0,
              lastSeen: 0,
              nextRetryAt: null,
              capabilities: { open: true, close: false, flash: true, provisionWifi: false },
            },
          ],
        }),
      ],
    });
    expect(el.querySelector('[data-testid="app-header-not-usable"]')?.textContent).toBe("Not connected");
    const connect = el.querySelector<HTMLButtonElement>('[data-testid="app-header-connect"]');
    expect(connect).not.toBeNull();
    expect(connect!.disabled).toBe(false);
    act(() => {
      connect!.click();
    });
    expect(socket().sent.map((raw) => JSON.parse(raw))).toContainEqual({ type: "session-open", linkId: "usb-SERIAL-A" });
    // No sibling link exists on this device -- no switch offer.
    expect(el.querySelector('[data-testid="app-header-switch-link"]')).toBeNull();
  });

  it("Connect is disabled once the socket closes (useSendable false)", () => {
    const { el, socket } = mountAt("/d/usb-SERIAL-A", {
      devices: [device()], // default link: state "connectable", no session
    });
    expect(el.querySelector<HTMLButtonElement>('[data-testid="app-header-connect"]')!.disabled).toBe(false);
    act(() => {
      socket().close();
    });
    expect(el.querySelector<HTMLButtonElement>('[data-testid="app-header-connect"]')!.disabled).toBe(true);
  });

  it("when a sibling link on the same device is usable, offers 'Use <label> instead' pointing at /d/<thatLinkId>", () => {
    const { el } = mountAt("/d/usb-SERIAL-A", {
      devices: [
        device({
          links: [
            {
              id: "usb-SERIAL-A",
              transport: "usb",
              label: "USB · /dev/cu.usbmodemA",
              state: "connectable",
              reason: null,
              since: 0,
              lastSeen: 0,
              nextRetryAt: null,
              capabilities: { open: true, close: false, flash: true, provisionWifi: false },
            },
            {
              id: "mbserial-zeguz",
              transport: "mbserial",
              label: "mbserial · zeguz",
              state: "connected",
              reason: null,
              since: 0,
              lastSeen: 0,
              nextRetryAt: null,
              session: OPEN_SESSION,
              capabilities: { open: true, close: true, flash: false, provisionWifi: true },
            },
          ],
        }),
      ],
    });
    const switchLink = el.querySelector<HTMLAnchorElement>('[data-testid="app-header-switch-link"]');
    expect(switchLink).not.toBeNull();
    expect(switchLink!.textContent).toBe("Use mbserial · zeguz instead");
    expect(switchLink!.getAttribute("href")).toBe("/d/mbserial-zeguz");
  });

  it("extended scope (item C): a link whose session survived but is no longer usable (unresponsive) reads 'Not connected over <label>: <plain reason>', not the ticket's plain 'no session' text", () => {
    const { el } = mountAt("/d/usb-SERIAL-A", {
      devices: [
        device({
          links: [
            {
              id: "usb-SERIAL-A",
              transport: "usb",
              label: "USB · /dev/cu.usbmodemA",
              state: "unresponsive",
              reason: "no reply to 3 STATUS polls -- link presumed dead",
              since: 0,
              lastSeen: 0,
              nextRetryAt: null,
              session: OPEN_SESSION,
              capabilities: { open: false, close: true, flash: true, provisionWifi: true },
            },
          ],
        }),
      ],
    });
    // 018-010: the raw harvester reason is routed through
    // `plainFailureReason` (never shown verbatim -- "no raw reasons"),
    // which reads this exact shape as "stopped answering".
    expect(el.querySelector('[data-testid="app-header-not-usable"]')?.textContent).toBe(
      "Not connected over USB · /dev/cu.usbmodemA: stopped answering",
    );
    // Still offered a way forward -- Connect -- exactly like the
    // no-session case.
    expect(el.querySelector('[data-testid="app-header-connect"]')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------
// Ticket 018-010, second pass: relay header text (defect 2) and Flash
// gating by transport (defect 4).
// ---------------------------------------------------------------------

function relayDevice(overrides: Partial<Omit<SnapshotDevice, "links">> & { links?: SnapshotDevice["links"] } = {}): SnapshotDevice {
  return device({
    id: 9,
    name: "torture",
    kind: "relay",
    role: "RADIOBRIDGE",
    links: [
      {
        id: "mbrelay-torture",
        transport: "mbrelay",
        label: "mbrelay · torture.local:8760",
        state: "connected",
        reason: null,
        since: 0,
        lastSeen: 0,
        nextRetryAt: null,
        capabilities: { open: false, close: true, flash: false, provisionWifi: false },
      },
    ],
    ...overrides,
  });
}

describe("AppHeader relay connection text (ticket 018-010, defect 2)", () => {
  it("an idle relay (no bridge, no lease) reads plain 'idle' -- no session wording, no Connect button, no switch link", () => {
    const { el } = mountAt("/d/mbrelay-torture", { devices: [relayDevice()] });
    expect(el.querySelector('[data-testid="app-header-connection-state"]')?.textContent).toBe("idle");
    expect(el.querySelector('[data-testid="app-header-not-usable"]')).toBeNull();
    expect(el.querySelector('[data-testid="app-header-connect"]')).toBeNull();
    expect(el.querySelector('[data-testid="app-header-switch-link"]')).toBeNull();
    expect(el.textContent).not.toContain("session");
  });

  it("a relay currently bridging a robot names that robot, not raw ids", () => {
    const robot = device({
      id: 42,
      name: "tigez",
      kind: "robot",
      links: [
        {
          id: "radio-tigez-via-mbrelay-torture",
          transport: "radio",
          label: "Radio · ch55/grp114",
          state: "connected",
          reason: null,
          since: 0,
          lastSeen: 0,
          nextRetryAt: null,
          session: OPEN_SESSION,
          via: { relayLinkId: "mbrelay-torture", relayName: "torture", channel: 55, group: 114, addressSource: "derived" },
          capabilities: { open: true, close: true, flash: false, provisionWifi: false },
        },
      ],
    });
    const { el } = mountAt("/d/mbrelay-torture", { devices: [relayDevice(), robot] });
    // Exactly `relayStatusText`'s own "connected" text (the one shared
    // module every relay bridging-status render reads) -- names the
    // robot and its channel/group, never the raw link/candidate id.
    expect(el.querySelector('[data-testid="app-header-connection-state"]')?.textContent).toBe(
      "Connected to tigez on channel 55, group 114",
    );
  });

  it("a relay whose own link cannot be reached shows a plain, relay-shaped failure reason, no raw ids", () => {
    const { el } = mountAt("/d/mbrelay-torture", {
      devices: [
        relayDevice({
          links: [
            {
              id: "mbrelay-torture",
              transport: "mbrelay",
              label: "mbrelay · torture.local:8760",
              state: "failed",
              reason: 'relayBridger: candidate "radio-tigez-via-mbrelay-torture" produced no banner within the identify budget',
              since: 0,
              lastSeen: 0,
              nextRetryAt: null,
              capabilities: { open: true, close: false, flash: false, provisionWifi: false },
            },
          ],
        }),
      ],
    });
    const text = el.querySelector('[data-testid="app-header-connection-state"]')?.textContent ?? "";
    expect(text).not.toContain("radio-tigez-via-mbrelay-torture");
    expect(text).not.toContain("relayBridger");
    expect(text).toContain("the relay didn't answer");
  });
});

describe("AppHeader Flash gating by transport (ticket 018-010, defect 4)", () => {
  it("offers no Flash trigger for an identified relay reached over mbrelay/TCP -- flashing can never work there", () => {
    const { el } = mountAt("/d/mbrelay-torture", { devices: [relayDevice()] });
    expect(flashTrigger(el)).toBeUndefined();
  });

  it("offers no Flash trigger for an identified robot reached over WiFi -- flashing can never work there", () => {
    const { el } = mountAt("/d/wifi-gopiv", {
      devices: [
        device({
          id: 7,
          name: "gopiv",
          links: [
            {
              id: "wifi-gopiv",
              transport: "wifi",
              label: "WiFi · gopiv.local:7654",
              state: "connected",
              reason: null,
              since: 0,
              lastSeen: 0,
              nextRetryAt: null,
              session: OPEN_SESSION,
              capabilities: { open: false, close: true, flash: false, provisionWifi: true },
            },
          ],
        }),
      ],
    });
    expect(flashTrigger(el)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// Sprint 023 ticket 006 (SUC-002/SUC-003): the header's Flash dialog
// narrows to the routed device's own firmware kind once identified, and
// stays permissive (all three kinds + local hex) with no identified
// device yet -- see AppHeader.tsx's own doc comment ("Sprint 023 ticket
// 006") for the derivation. Each assertion below checks *absence* from
// the DOM, not merely a disabled button -- the acceptance criteria's own
// requirement, since a disabled-but-present button could still be
// re-enabled by a firmware-availability change with no code change here.
// ---------------------------------------------------------------------

const ALL_FIRMWARE_BUTTON_TEXTS = ["Flash relay firmware", "Flash robot firmware", "Flash joystick firmware"];

function openFlashDialog(el: HTMLDivElement): void {
  act(() => {
    flashTrigger(el)!.click();
  });
}

describe("AppHeader Flash button set restricted to device kind (sprint 023 ticket 006)", () => {
  it("an identified robot's own page offers exactly 'Flash robot firmware' -- no relay, no joystick, no local hex", () => {
    const { el } = mountAt("/d/usb-SERIAL-A", {
      devices: [
        device({
          role: "NEZHA2",
          links: [
            {
              id: "usb-SERIAL-A",
              transport: "usb",
              label: "USB · /dev/cu.usbmodemA",
              state: "connected",
              reason: null,
              since: 0,
              lastSeen: 0,
              nextRetryAt: null,
              capabilities: { open: false, close: true, flash: false, provisionWifi: true },
            },
          ],
        }),
      ],
    });
    openFlashDialog(el);
    expect(el.textContent).toContain("Flash robot firmware");
    expect(el.textContent).not.toContain("Flash relay firmware");
    expect(el.textContent).not.toContain("Flash joystick firmware");
    expect(el.querySelector('[data-testid="local-hex-file-input"]')).toBeNull();
    expect(el.textContent).not.toContain("Flash a hex file from disk");
  });

  it("an identified relay's own page offers exactly 'Flash relay firmware' -- no robot, no joystick, no local hex", () => {
    const { el } = mountAt("/d/usb-RELAY-A", {
      devices: [
        device({
          id: 2,
          kind: "relay",
          role: "RADIOBRIDGE",
          links: [
            {
              id: "usb-RELAY-A",
              transport: "usb",
              label: "USB · relay",
              state: "connected",
              reason: null,
              since: 0,
              lastSeen: 0,
              nextRetryAt: null,
              capabilities: { open: false, close: true, flash: true, provisionWifi: false },
            },
          ],
        }),
      ],
    });
    openFlashDialog(el);
    expect(el.textContent).toContain("Flash relay firmware");
    expect(el.textContent).not.toContain("Flash robot firmware");
    expect(el.textContent).not.toContain("Flash joystick firmware");
    expect(el.querySelector('[data-testid="local-hex-file-input"]')).toBeNull();
    expect(el.textContent).not.toContain("Flash a hex file from disk");
  });

  it("this restriction holds even when the OTHER kind's firmware is available -- absent from the DOM, not merely disabled", () => {
    // A robot's own page must never show a relay button, even one that
    // would render enabled if it were shown at all -- the acceptance
    // criterion this test exists to pin.
    const { el } = mountAt("/d/usb-SERIAL-A", {
      devices: [
        device({
          role: "NEZHA2",
          links: [
            {
              id: "usb-SERIAL-A",
              transport: "usb",
              label: "USB · /dev/cu.usbmodemA",
              state: "connected",
              reason: null,
              since: 0,
              lastSeen: 0,
              nextRetryAt: null,
              capabilities: { open: false, close: true, flash: false, provisionWifi: true },
            },
          ],
        }),
      ],
    });
    openFlashDialog(el);
    for (const disallowedText of ["Flash relay firmware", "Flash joystick firmware"]) {
      expect(Array.from(el.querySelectorAll("button")).some((b) => b.textContent === disallowedText)).toBe(false);
    }
  });

  it("a link with no resolved device yet (an unassigned board reached via /d/:linkId) offers all four options, matching UnknownDevicePage", () => {
    const { el } = mountAt("/d/usb-unknown-1", {
      unassigned: [
        {
          id: "usb-unknown-1",
          transport: "usb",
          label: "USB · /dev/tty.usbmodem-unknown",
          state: "connectable",
          reason: null,
          since: 0,
          lastSeen: 0,
          nextRetryAt: null,
          capabilities: { open: true, close: false, flash: true, provisionWifi: false },
        },
      ],
    });
    openFlashDialog(el);
    for (const text of ALL_FIRMWARE_BUTTON_TEXTS) {
      expect(el.textContent).toContain(text);
    }
    expect(el.textContent).toContain("Flash a hex file from disk");
  });
});

describe("AppHeader Set Wi-Fi (sprint 015 ticket 008 restore)", () => {
  it("shows no Set Wi-Fi trigger on / or in the loading state", () => {
    expect(mountAt("/").el.querySelector('[data-testid="wifi-credentials-trigger"]')).toBeNull();
    expect(mountAt("/d/usb-SERIAL-A").el.querySelector('[data-testid="wifi-credentials-trigger"]')).toBeNull();
  });

  it("shows Set Wi-Fi for a robot device page, keyed by the routed link", () => {
    const { el, socket } = mountAt("/d/usb-SERIAL-A", {
      devices: [
        device({
          id: 42,
          name: "tigez",
          links: [
            {
              id: "usb-SERIAL-A",
              transport: "usb",
              label: "USB · /dev/cu.usbmodemA",
              state: "connected",
              reason: null,
              since: 0,
              lastSeen: 0,
              nextRetryAt: null,
              session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null },
              capabilities: { open: false, close: true, flash: true, provisionWifi: true },
            },
          ],
        }),
      ],
    });
    const trigger = el.querySelector<HTMLButtonElement>('[data-testid="wifi-credentials-trigger"]');
    expect(trigger).not.toBeNull();
    act(() => {
      trigger!.click();
    });
    expect(el.querySelector("h2")?.textContent).toBe("Set Wi-Fi on tigez");
    act(() => {
      socket().emitMessage({ type: "wifi-credentials", ssid: "Busboom_Garage", hasPassword: true, source: "env", seq: 99 });
    });
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="wifi-write"]')!.click();
    });
    expect(socket().sent.map((raw) => JSON.parse(raw))).toContainEqual({
      type: "provision-wifi",
      linkId: "usb-SERIAL-A",
      slot: 0,
    });
  });

  it("shows no Set Wi-Fi trigger for a relay device page", () => {
    const { el } = mountAt("/d/usb-RELAY-A", {
      devices: [
        device({
          id: 2,
          kind: "relay",
          links: [
            {
              id: "usb-RELAY-A",
              transport: "usb",
              label: "USB · relay",
              state: "connected",
              reason: null,
              since: 0,
              lastSeen: 0,
              nextRetryAt: null,
              capabilities: { open: false, close: true, flash: true, provisionWifi: false },
            },
          ],
        }),
      ],
    });
    expect(el.querySelector('[data-testid="wifi-credentials-trigger"]')).toBeNull();
  });
});

describe("AppHeader host version display (stakeholder: version on the main page)", () => {
  // The version rides the snapshot over the WebSocket, not an HTTP
  // fetch. An earlier version of this feature fetched
  // `/api/host-info` relative to the page, which works only when the
  // page and host share an origin -- and under `npm run dev` they do
  // not: Vite serves the UI on 5173 while the host listens on 4795.
  // Chrome blocked it outright ("Access to fetch at
  // 'http://0.0.0.0:4795/api/host-info' from origin
  // 'http://localhost:5173' has been blocked by CORS policy"), so the
  // version silently never appeared and these tests still passed,
  // because they stubbed `fetch` and never exercised a real origin.
  function mountWithVersion(hostVersion?: string): HTMLDivElement {
    let socket: FakeSocket | null = null;
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
          <AppHeader />
        </WsProvider>,
        { initialEntries: ["/"] },
      ),
    );
    act(() => {
      socket!.emitOpen();
    });
    act(() => {
      socket!.emitMessage(snapshot([], hostVersion));
    });
    return el;
  }

  it("shows the running host's version right after the name", () => {
    const el = mountWithVersion("0.20260919.12");
    expect(el.querySelector('[data-testid="host-version"]')?.textContent?.trim()).toBe("0.20260919.12");
    expect(el.querySelector("h1")?.textContent).toContain("robot-console");
  });

  it("renders just the name, never a placeholder, when the host reports no version", () => {
    const el = mountWithVersion(undefined);
    expect(el.querySelector('[data-testid="host-version"]')).toBeNull();
    expect(el.querySelector("h1")?.textContent?.trim()).toBe("robot-console");
  });

  it("renders just the name before any snapshot has arrived", () => {
    const { el } = mountAt("/");
    expect(el.querySelector('[data-testid="host-version"]')).toBeNull();
    expect(el.querySelector("h1")?.textContent?.trim()).toBe("robot-console");
  });
});
