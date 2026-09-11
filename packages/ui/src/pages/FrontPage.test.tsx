// @vitest-environment jsdom
/**
 * FrontPage.test.tsx — component-level tests for the front page
 * (ticket 007 / SUC-001).
 *
 * Presentational assertions here are migrated from
 * `DevicesTab.test.tsx`'s `DevicesList` suite (normal row, flagged/
 * unnamed, unresponsive, no serial port, empty state, reconnecting
 * banner) -- nothing about *what* a row shows changed, only *what a
 * row does when clicked* (a real navigation, dropped Connect/
 * Disconnect/flash actions). The Connect/Disconnect/flash-button
 * assertions are **not** migrated -- those controls move to the
 * per-device page in ticket 008 and stay covered by
 * `DevicesTab.test.tsx` in the meantime (that component is left in
 * place, just unrouted from `App.tsx`).
 *
 * Two layers, matching `DevicesTab.test.tsx`'s own split:
 *  - `EndpointsList` (presentational) exercised directly against
 *    plain `EndpointListEntry` fixtures.
 *  - One test drives the real `FrontPage` through `WsProvider` +
 *    `AppRoutes`, against a fake socket, proving a card click performs
 *    a real router navigation to the clicked endpoint's page.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type {
  DiscoveredRobotEntry,
  EndpointListEntry,
  RememberedRobotEntry,
} from "@robot-console/host/src/wsMessages.js";
import { EndpointsList, FrontPage, groupEndpointsByRobot } from "./FrontPage";
import { AppRoutes } from "../router";
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

/** Convenience shape for fixture construction -- mirrors
 * `DevicesTab.test.tsx`'s `baseDevice`. */
interface BaseDeviceOverrides {
  id?: string;
  serialNumber?: string;
  displaySerial?: string;
  name?: string | null;
  role?: string | null;
  port?: string | null;
  linkOpen?: boolean;
  linkError?: string;
  nameError?: { reason: string; message: string };
}

function classificationFor(role: string | null): EndpointListEntry["classification"] {
  if (role === null) {
    return { type: "unknown", role: null, commonName: null, dialect: null, evidence: "none", program: null, version: null };
  }
  if (role === "NEZHA2") {
    return { type: "robot", role, commonName: "robot", dialect: "space", evidence: "role", program: null, version: null };
  }
  return { type: "unknown", role, commonName: null, dialect: null, evidence: "unrecognized", program: null, version: null };
}

function baseDevice(overrides: BaseDeviceOverrides = {}): EndpointListEntry {
  const id = overrides.id ?? "SERIAL-A";
  const role = "role" in overrides ? (overrides.role ?? null) : "NEZHA2";
  const port = "port" in overrides ? (overrides.port ?? null) : "/dev/cu.usbmodemA";
  const entry: EndpointListEntry = {
    endpointId: `usb-${id}`,
    transport: "usb",
    resourceKey: `usb-${id}`,
    classification: classificationFor(role),
    name: "name" in overrides ? (overrides.name ?? null) : "zeguz",
    role,
    sessionOpen: overrides.linkOpen ?? true,
    usb: {
      serialNumber: overrides.serialNumber ?? "SERIAL-A-FULL",
      displaySerial: overrides.displaySerial ?? "0002",
      port,
    },
  };
  if (overrides.nameError) {
    entry.nameError = overrides.nameError;
  }
  if (overrides.linkError) {
    entry.sessionError = overrides.linkError;
  }
  return entry;
}

const NO_FIRMWARE_STATUS = {
  relay: { configured: false as const },
  robot: { configured: false as const },
};

/** Convenience fixture for `RememberedRobotEntry` -- mirrors
 * `baseDevice`'s role in this file. */
function rememberedRobotFixture(name: string, overrides: Partial<RememberedRobotEntry> = {}): RememberedRobotEntry {
  return {
    name,
    lastSeenAt: "2026-01-01T12:34:00.000Z",
    lastSeenVia: "usb",
    lastRole: null,
    lastUsbSerial: `${name}-SERIAL`,
    ...overrides,
  };
}

describe("EndpointsList", () => {
  it("renders a normal device row with name, role, port, and device id", () => {
    const el = mount(withRouter(<EndpointsList status="open" devices={[baseDevice()]} />));

    const text = el.textContent ?? "";
    expect(text).toContain("zeguz");
    expect(text).toContain("NEZHA2");
    expect(text).toContain("/dev/cu.usbmodemA");
    expect(text).toContain("0002");
  });

  // `role: null` makes this device `canBeFlashed`, so its card now
  // mounts `FlashControls` (ticket 012-002), which reads `WsProvider`'s
  // hooks -- unlike every other `EndpointsList`-only test in this
  // block, this fixture needs a real provider around it.
  it("flags a device that failed SWD naming as unnamed/error, not omitted", () => {
    let socket: FakeSocket | null = null;
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
          <EndpointsList
            status="open"
            devices={[
              baseDevice({
                id: "SERIAL-B",
                name: null,
                role: null,
                nameError: { reason: "swd-attach-failed", message: "could not attach over SWD" },
              }),
            ]}
          />
        </WsProvider>,
      ),
    );
    act(() => {
      socket!.emitOpen();
    });

    const text = el.textContent ?? "";
    expect(text).toContain("Unnamed device");
    expect(text).toContain("could not attach over SWD");
    expect(el.querySelector('[data-testid="device-usb-SERIAL-B"]')).not.toBeNull();
  });

  // Same `role: null` / `WsProvider` note as above.
  it("shows a device that never replied to HELLO as unresponsive, not assigned a role", () => {
    let socket: FakeSocket | null = null;
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
          <EndpointsList
            status="open"
            devices={[
              baseDevice({
                id: "SERIAL-C",
                role: null,
                linkOpen: false,
                linkError: "HELLO reply timed out after 2000ms",
              }),
            ]}
          />
        </WsProvider>,
      ),
    );
    act(() => {
      socket!.emitOpen();
    });

    const text = el.textContent ?? "";
    expect(text).toContain("Unresponsive");
    expect(text).toContain("HELLO reply timed out after 2000ms");
    expect(text).not.toContain("NEZHA2");
  });

  it("shows a device with no serial port as 'No serial port' in its port field", () => {
    const el = mount(
      withRouter(
        <EndpointsList status="open" devices={[baseDevice({ id: "SERIAL-D", port: null, linkOpen: false })]} />,
      ),
    );

    expect(el.textContent ?? "").toContain("No serial port");
  });

  it("shows a reconnecting banner without dropping the last-known device list", () => {
    const el = mount(withRouter(<EndpointsList status="closed" devices={[baseDevice()]} />));

    const text = el.textContent ?? "";
    expect(text).toContain("reconnecting");
    expect(text).toContain("zeguz");
  });

  it("shows 'no devices detected yet' when the list is empty", () => {
    const el = mount(withRouter(<EndpointsList status="open" devices={[]} />));

    expect(el.textContent ?? "").toContain("No devices detected yet");
  });

  it("renders each row as a real link to its device page", () => {
    const el = mount(withRouter(<EndpointsList status="open" devices={[baseDevice({ id: "SERIAL-LINK" })]} />));

    const link = el.querySelector('[data-testid="device-usb-SERIAL-LINK"]');
    expect(link?.tagName).toBe("A");
    expect(link?.getAttribute("href")).toBe("/d/usb-SERIAL-LINK");
  });
});

describe("FrontPage navigation", () => {
  it("navigates to /d/:endpointId when a device card is clicked", () => {
    let socket: FakeSocket | null = null;
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
          <AppRoutes />
        </WsProvider>,
      ),
    );

    act(() => {
      socket!.emitOpen();
    });
    act(() => {
      socket!.emitMessage({
        type: "endpoints",
        endpoints: [baseDevice({ id: "SERIAL-NAV", name: "kivon" })],
      });
    });

    const card = el.querySelector('[data-testid="device-usb-SERIAL-NAV"]');
    expect(card).not.toBeNull();
    act(() => {
      card!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(el.querySelector('[data-testid="location"]')?.textContent).toBe("/d/usb-SERIAL-NAV");
    // The default fixture classifies as "robot" (role "NEZHA2") -- ticket
    // 008 replaced ticket 007's "Device found: ..." placeholder with the
    // real per-type page content, so this now lands on `RobotPage`.
    expect(el.textContent).toContain("kivon");
  });
});

describe("EndpointCard flash affordance (ticket 012-002)", () => {
  const FIRMWARE_STATUS_FIXTURE = {
    relay: { configured: true as const, repoUrl: "https://example.test/relay", tag: "v1", available: true },
    robot: { configured: true as const, repoUrl: "https://example.test/robot", tag: "v1", available: true },
  };

  function mountFrontPage(device: EndpointListEntry): { el: HTMLDivElement; socket: () => FakeSocket } {
    let socket: FakeSocket | null = null;
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
          <AppRoutes />
        </WsProvider>,
      ),
    );
    act(() => {
      socket!.emitOpen();
    });
    act(() => {
      socket!.emitMessage({
        type: "endpoints",
        endpoints: [device],
        firmwareStatus: FIRMWARE_STATUS_FIXTURE,
      });
    });
    return { el, socket: () => socket! };
  }

  it("shows a Flash trigger, as a sibling of the card's Link, for a canBeFlashed device", () => {
    const device = baseDevice({ id: "SERIAL-FLASH", role: null });
    const { el } = mountFrontPage(device);

    const card = el.querySelector('[data-testid="device-usb-SERIAL-FLASH"]');
    const actions = el.querySelector('[data-testid="device-actions-usb-SERIAL-FLASH"]');
    expect(card).not.toBeNull();
    expect(actions).not.toBeNull();
    // OOP 2026-09-10: the open arrow is the card's only anchor; the
    // action row sits beside it inside the same card, never inside it.
    expect(el.querySelector('[data-testid="device-card-usb-SERIAL-FLASH"]')?.contains(actions)).toBe(true);
    // Siblings inside the same `<li>`, not one nested inside the other.
    expect(actions?.contains(card)).toBe(false);
    expect(card?.contains(actions)).toBe(false);
    expect(actions?.textContent).toContain("Flash");
  });

  it("opens the flash dialog, revealing the flash flow, when the trigger is clicked", () => {
    const device = baseDevice({ id: "SERIAL-FLASH-OPEN", role: null });
    const { el } = mountFrontPage(device);

    const actions = el.querySelector('[data-testid="device-actions-usb-SERIAL-FLASH-OPEN"]');
    const flashTrigger = Array.from(actions?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent === "Flash",
    );
    expect(flashTrigger).toBeDefined();
    expect(el.querySelector("dialog")).toBeNull();

    act(() => {
      flashTrigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(el.querySelector("dialog")).not.toBeNull();
    expect(el.textContent).toContain("Flash relay firmware");
  });

  it("shows no flash action row for an identified (not canBeFlashed) device -- no visual regression", () => {
    const device = baseDevice({ id: "SERIAL-IDENT" }); // default role "NEZHA2"
    const { el } = mountFrontPage(device);

    expect(el.querySelector('[data-testid="device-actions-usb-SERIAL-IDENT"]')).toBeNull();
    expect(el.textContent).not.toContain("Flash relay firmware");
    expect(el.textContent).not.toContain("Flash robot firmware");
  });

  it("the card's <a> contains no <button>/<input> descendant (invalid-nesting regression)", () => {
    const device = baseDevice({ id: "SERIAL-NEST", role: null });
    const { el } = mountFrontPage(device);

    const link = el.querySelector('[data-testid="device-usb-SERIAL-NEST"]');
    expect(link?.tagName).toBe("A");
    expect(link?.querySelector("button")).toBeNull();
    expect(link?.querySelector("input")).toBeNull();
  });

  it("OOP 2026-09-10: clicking the informational region no longer navigates; only the open arrow does", () => {
    const device = baseDevice({ id: "SERIAL-NAV2", role: null, name: "kivon" });
    const { el } = mountFrontPage(device);

    const nameHeading = el.querySelector('[data-testid="device-card-usb-SERIAL-NAV2"] .device-name');
    expect(nameHeading).not.toBeNull();
    act(() => {
      nameHeading!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(el.querySelector('[data-testid="location"]')?.textContent).toBe("/");

    const arrow = el.querySelector('[data-testid="device-usb-SERIAL-NAV2"]');
    expect(arrow?.tagName).toBe("A");
    expect(arrow?.getAttribute("aria-label")).toBe("Open kivon");
    act(() => {
      arrow!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(el.querySelector('[data-testid="location"]')?.textContent).toBe("/d/usb-SERIAL-NAV2");
  });

  it("clicking a flash button in the action row's dialog sends flash-start without navigating away", () => {
    const device = baseDevice({ id: "SERIAL-NONAV", role: null });
    const { el, socket } = mountFrontPage(device);

    const actions = el.querySelector('[data-testid="device-actions-usb-SERIAL-NONAV"]');
    const flashTrigger = Array.from(actions?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent === "Flash",
    );
    act(() => {
      flashTrigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const relayButton = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "Flash relay firmware",
    );
    expect(relayButton).toBeDefined();
    act(() => {
      relayButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(el.querySelector('[data-testid="location"]')?.textContent).toBe("/");
    expect(socket().sent).toEqual([
      JSON.stringify({
        type: "flash-start",
        endpointId: "usb-SERIAL-NONAV",
        source: { kind: "release", firmware: "relay" },
      }),
    ]);
  });
});

describe("EndpointCard for a relay-radio (viaRelay) entry (added out-of-process, 2026-09-09)", () => {
  function relayFixture(): EndpointListEntry {
    return {
      endpointId: "usb-RELAY-A",
      transport: "usb",
      resourceKey: "usb-RELAY-A",
      classification: { type: "relay", role: "RADIORELAY", commonName: "relay", dialect: "space", evidence: "role", program: null, version: null },
      name: "gopiv",
      role: "RADIORELAY",
      sessionOpen: false,
      usb: { serialNumber: "RELAY-A-FULL", displaySerial: "0003", port: "/dev/cu.usbmodemB" },
    };
  }

  function childFixture(): EndpointListEntry {
    return {
      endpointId: "usb-RELAY-A-via-vevav",
      transport: "relay-radio",
      resourceKey: "usb-RELAY-A",
      classification: { type: "robot", role: "NEZHA2", commonName: "robot", dialect: "space", evidence: "role", program: null, version: null },
      name: "vevav",
      role: "NEZHA2",
      sessionOpen: true,
      viaRelay: { relayEndpointId: "usb-RELAY-A", robotName: "vevav", channel: 55, group: 114 },
    };
  }

  it("shows 'via relay <name>' instead of a port/device-id line, using the relay's own display name", () => {
    const el = mount(withRouter(<EndpointsList status="open" devices={[relayFixture(), childFixture()]} />));

    const card = el.querySelector('[data-testid="device-card-usb-RELAY-A-via-vevav"]');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain("via relay gopiv");
    expect(card!.textContent).not.toContain("No serial port");
    expect(card!.querySelector("dt")?.textContent).toBe("Role");
  });

  it("links to /d/<childId> like any other endpoint", () => {
    const el = mount(withRouter(<EndpointsList status="open" devices={[relayFixture(), childFixture()]} />));

    const link = el.querySelector('[data-testid="device-usb-RELAY-A-via-vevav"]');
    expect(link?.tagName).toBe("A");
    expect(link?.getAttribute("href")).toBe("/d/usb-RELAY-A-via-vevav");
  });

  it("falls back to the bare relay id if the relay itself isn't in the snapshot", () => {
    const el = mount(withRouter(<EndpointsList status="open" devices={[childFixture()]} />));

    const card = el.querySelector('[data-testid="device-card-usb-RELAY-A-via-vevav"]');
    expect(card!.textContent).toContain("via relay usb-RELAY-A");
  });
});

describe("EndpointCard for a wifi entry (sprint 10 ticket 005)", () => {
  /** A WiFi-reachable roster robot's endpoint, mirroring the contract
   * `deviceRegistry.ts`/ticket 003 synthesize: `endpointId: "wifi-<name>"`,
   * `transport: "wifi"`, a `wifi: { host, port }` block, no `usb` block.
   * Not yet connected (`classification.type: "unknown"`, no `role`) by
   * default -- ticket 003's own note that a WiFi endpoint's
   * classification stays `"unknown"` until a session opens and
   * identifies it. */
  function wifiFixture(overrides: Partial<EndpointListEntry> = {}): EndpointListEntry {
    return {
      endpointId: "wifi-gopiv",
      transport: "wifi",
      resourceKey: "wifi-gopiv",
      classification: { type: "unknown", role: null, commonName: null, dialect: null, evidence: "none", program: null, version: null },
      name: "gopiv",
      role: null,
      sessionOpen: false,
      wifi: { host: "192.168.1.42", port: 8765 },
      ...overrides,
    };
  }

  // `role: null` (not yet identified) makes this fixture `canBeFlashed`,
  // so its card mounts `FlashDialog` (ticket 012-002), which reads
  // `WsProvider`'s hooks -- same note as the "flags a device..."
  // `EndpointsList` test above, this fixture needs a real provider.
  it("shows a WiFi-distinguishing label with host:port for a not-yet-connected wifi entry", () => {
    let socket: FakeSocket | null = null;
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
          <EndpointsList status="open" devices={[wifiFixture()]} />
        </WsProvider>,
      ),
    );
    act(() => {
      socket!.emitOpen();
    });

    const card = el.querySelector('[data-testid="device-card-wifi-gopiv"]');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain("WiFi");
    expect(card!.textContent).toContain("192.168.1.42:8765");
    expect(card!.textContent).not.toContain("No serial port");
    expect(card!.querySelector(".device-linked-pill")).toBeNull();
  });

  it("keeps the same WiFi label once the entry is open and identified", () => {
    const el = mount(
      withRouter(
        <EndpointsList
          status="open"
          devices={[
            wifiFixture({
              classification: {
                type: "robot",
                role: "NEZHA2",
                commonName: "robot",
                dialect: "space",
                evidence: "role", program: null, version: null,
              },
              role: "NEZHA2",
              sessionOpen: true,
            }),
          ]}
        />,
      ),
    );

    const card = el.querySelector('[data-testid="device-card-wifi-gopiv"]');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain("WiFi");
    expect(card!.textContent).toContain("192.168.1.42:8765");
    expect(card!.querySelector(".device-linked-pill")).not.toBeNull();
  });

  it("links to /d/wifi-<name> like any other endpoint", () => {
    let socket: FakeSocket | null = null;
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
          <EndpointsList status="open" devices={[wifiFixture()]} />
        </WsProvider>,
      ),
    );
    act(() => {
      socket!.emitOpen();
    });

    const link = el.querySelector('[data-testid="device-wifi-gopiv"]');
    expect(link?.tagName).toBe("A");
    expect(link?.getAttribute("href")).toBe("/d/wifi-gopiv");
  });

  // Ticket 002/003 already enforce, host-side, that a robot never
  // becomes a `wifi-<name>` `EndpointListEntry` unless it matches the
  // roster (`rememberedRobots`) by name -- an ungated mDNS discovery
  // never gets promoted. This is the UI-level restatement of that
  // negative case, not a new enforcement point: `EndpointsList` renders
  // purely off the `devices` snapshot it's handed and has no discovery
  // list of its own to consult, so a name that never made it into
  // `devices` (e.g. because the host's roster gate rejected it) can
  // never produce a card, no matter what a raw discovery entry for it
  // looked like.
  it("renders no card, and no console error, for a name the host's roster gate never turned into an endpoint", () => {
    const discovered: DiscoveredRobotEntry = {
      instanceName: "zzzzz",
      host: "192.168.1.99",
      port: 8765,
    };

    const el = mount(withRouter(<EndpointsList status="open" devices={[]} />));

    expect(el.querySelector(`[data-testid="device-wifi-${discovered.instanceName}"]`)).toBeNull();
    expect(el.textContent ?? "").not.toContain(discovered.instanceName);
  });
});

describe("EndpointCard calibration badge (sprint 011 ticket 002)", () => {
  /** A calibration-classified robot's endpoint -- `classification.type`
   * refined to `"calibration"` by `refineForCalibration` (ticket 001)
   * after an `ID` reply whose `program` matched the `calibration-`
   * prefix. Mirrors `baseDevice`'s USB shape. */
  function calibrationFixture(overrides: Partial<EndpointListEntry> = {}): EndpointListEntry {
    return {
      endpointId: "usb-CAL-A",
      transport: "usb",
      resourceKey: "usb-CAL-A",
      classification: {
        type: "calibration",
        role: "NEZHA2",
        commonName: "robot",
        dialect: "space",
        evidence: "role",
        program: "calibration-0.20260907.2",
        version: "0.20260907.2",
      },
      name: "kivon",
      role: "NEZHA2",
      sessionOpen: true,
      usb: { serialNumber: "CAL-A-FULL", displaySerial: "0005", port: "/dev/cu.usbmodemD" },
      ...overrides,
    };
  }

  it("shows a distinguishing calibration badge with the version for a calibration-classified card", () => {
    const el = mount(withRouter(<EndpointsList status="open" devices={[calibrationFixture()]} />));

    const badge = el.querySelector('[data-testid="calibration-badge"]');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe("Calibration robot · 0.20260907.2");
  });

  it("falls back to a version-less badge when classification.version is null", () => {
    const el = mount(
      withRouter(
        <EndpointsList
          status="open"
          devices={[calibrationFixture({ classification: { ...calibrationFixture().classification, version: null } })]}
        />,
      ),
    );

    const badge = el.querySelector('[data-testid="calibration-badge"]');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe("Calibration robot");
  });

  it("shows no calibration badge for a plain robot-classified card (regression)", () => {
    const el = mount(withRouter(<EndpointsList status="open" devices={[baseDevice()]} />));

    expect(el.querySelector('[data-testid="calibration-badge"]')).toBeNull();
    expect(el.textContent ?? "").not.toContain("Calibration robot");
  });
});

describe("RememberedRobotsSection (ticket 005)", () => {
  it("renders a remembered robot's name and lastSeenAt, with no Link for that card", () => {
    const robot = rememberedRobotFixture("wobin");
    const el = mount(withRouter(<EndpointsList status="open" devices={[]} rememberedRobots={[robot]} />));

    const text = el.textContent ?? "";
    expect(text).toContain("wobin");
    expect(text).toContain(new Date(robot.lastSeenAt).toLocaleString());

    const card = el.querySelector('[data-testid="remembered-robot-wobin"]');
    expect(card).not.toBeNull();
    expect(card?.tagName).not.toBe("A");
    expect(card?.querySelector("a")).toBeNull();
  });

  it("renders exactly one card each for an attached endpoint and a remembered robot with a different name", () => {
    const el = mount(
      withRouter(
        <EndpointsList
          status="open"
          devices={[baseDevice({ id: "SERIAL-E" })]}
          rememberedRobots={[rememberedRobotFixture("dorix")]}
        />,
      ),
    );

    // OOP 2026-09-10: a card is `device-card-<id>` plus its open arrow
    // `device-<id>` and one `device-link-<id>` row per link -- still
    // exactly one card.
    expect(el.querySelectorAll('[data-testid^="device-card-"]')).toHaveLength(1);
    expect(el.querySelectorAll('[data-testid^="remembered-robot-"]')).toHaveLength(1);
    expect(el.querySelector('[data-testid="device-usb-SERIAL-E"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="remembered-robot-dorix"]')).not.toBeNull();
  });

  it("renders no remembered-robot section (and no empty-state copy for it) when rememberedRobots is empty", () => {
    const el = mount(
      withRouter(<EndpointsList status="open" devices={[baseDevice()]} rememberedRobots={[]} />),
    );

    expect(el.querySelector(".remembered-robots")).toBeNull();
    expect(el.textContent ?? "").not.toContain("Robots remembered from before");
  });

  it("clicking Forget sends exactly { type: 'forget-known-robot', name } over the socket", () => {
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
      socket!.emitMessage({
        type: "endpoints",
        endpoints: [],
        firmwareStatus: NO_FIRMWARE_STATUS,
        rememberedRobots: [rememberedRobotFixture("nuvek")],
      });
    });

    const button = el.querySelector('[data-testid="remembered-robot-nuvek"] button');
    expect(button).not.toBeNull();
    act(() => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(socket!.sent).toEqual([JSON.stringify({ type: "forget-known-robot", name: "nuvek" })]);
  });

  it("the row disappears once the next snapshot omits it (no optimistic local removal needed)", () => {
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
      socket!.emitMessage({
        type: "endpoints",
        endpoints: [],
        firmwareStatus: NO_FIRMWARE_STATUS,
        rememberedRobots: [rememberedRobotFixture("nuvek")],
      });
    });
    expect(el.querySelector('[data-testid="remembered-robot-nuvek"]')).not.toBeNull();

    act(() => {
      socket!.emitMessage({
        type: "endpoints",
        endpoints: [],
        firmwareStatus: NO_FIRMWARE_STATUS,
        rememberedRobots: [],
      });
    });
    expect(el.querySelector('[data-testid="remembered-robot-nuvek"]')).toBeNull();
  });
});

describe("one card per robot (out-of-process, 2026-09-10)", () => {
  function wifiEntry(name: string, overrides: Partial<EndpointListEntry> = {}): EndpointListEntry {
    return {
      endpointId: `wifi-${name}`,
      transport: "wifi",
      resourceKey: `wifi-${name}`,
      classification: { type: "unknown", role: null, commonName: null, dialect: null, evidence: "none", program: null, version: null },
      name,
      role: null,
      sessionOpen: false,
      wifi: { host: `${name}.local`, port: 7654 },
      ...overrides,
    };
  }

  it("groupEndpointsByRobot folds a USB link and a WiFi link with the same name into one group led by the open USB link", () => {
    const usb = baseDevice({ id: "V", name: "vevov" });
    const wifi = wifiEntry("vevov", { sessionError: "could not reach vevov.local:7654" });
    const groups = groupEndpointsByRobot([wifi, usb]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe("vevov");
    expect(groups[0]?.primary.endpointId).toBe("usb-V");
    expect(groups[0]?.members.map((m) => m.endpointId)).toEqual(["usb-V", "wifi-vevov"]);
  });

  it("an open WiFi link outranks a closed USB link as the group's primary", () => {
    const usb = baseDevice({ id: "V", name: "vevov", linkOpen: false });
    const wifi = wifiEntry("vevov", { sessionOpen: true, role: "NEZHA2", classification: classificationFor("NEZHA2") });
    expect(groupEndpointsByRobot([usb, wifi])[0]?.primary.endpointId).toBe("wifi-vevov");
  });

  it("nameless endpoints never group, and different names stay separate", () => {
    const a = baseDevice({ id: "A", name: null });
    const b = baseDevice({ id: "B", name: null });
    const c = baseDevice({ id: "C", name: "tigez" });
    expect(groupEndpointsByRobot([a, b, c]).map((g) => g.key)).toEqual(["endpoint:usb-A", "endpoint:usb-B", "tigez"]);
  });

  it("renders exactly one card for a robot on USB and WiFi, linking to the USB page, with both links listed", () => {
    const usb = baseDevice({ id: "V", name: "vevov" });
    const wifi = wifiEntry("vevov", { sessionError: "could not reach vevov.local:7654" });
    const el = mount(withRouter(<EndpointsList status="open" devices={[wifi, usb]} />));

    expect(el.querySelectorAll("h3.device-name")).toHaveLength(1);
    expect(el.querySelector("h3.device-name")?.textContent).toBe("vevov");
    const card = el.querySelector('[data-testid="device-usb-V"]');
    expect(card?.getAttribute("href")).toBe("/d/usb-V");
    expect(el.querySelector('[data-testid="device-wifi-vevov"]')).toBeNull();

    const rows = el.querySelectorAll(".device-connections li");
    expect(rows).toHaveLength(2);
    const wifiRow = el.querySelector('[data-testid="device-link-wifi-vevov"]');
    expect(wifiRow?.textContent).toContain("WiFi · vevov.local:7654");
    expect(wifiRow?.textContent).toContain("Unreachable: could not reach vevov.local:7654");
    // The non-primary link carries its own small open arrow.
    expect(el.querySelector('[data-testid="device-row-open-wifi-vevov"]')?.getAttribute("href")).toBe("/d/wifi-vevov");
    expect(el.querySelector('[data-testid="device-row-open-usb-V"]')).toBeNull();
    expect(el.querySelector('[data-testid="device-link-usb-V"]')?.textContent).toContain("Linked");
    // No anchor nested in an anchor.
    expect(el.querySelectorAll("a a")).toHaveLength(0);
  });

  it("keeps the calibration badge from the identified USB link even when the WiFi link is the unidentified one", () => {
    const usb = baseDevice({ id: "V", name: "vevov" });
    usb.classification = { ...usb.classification, type: "calibration", program: "calibration-0.20260910.4", version: "1.20260910.2" };
    const wifi = wifiEntry("vevov");
    const el = mount(withRouter(<EndpointsList status="open" devices={[wifi, usb]} />));
    expect(el.querySelector('[data-testid="calibration-badge"]')?.textContent).toBe("Calibration robot · 1.20260910.2");
    expect(el.querySelector('[data-testid="calibration-badge"]')).not.toBeNull();
    expect(el.querySelectorAll('[data-testid="calibration-badge"]')).toHaveLength(1);
  });

  it("a single-link robot lists its one link with no extra row arrow, and its open arrow leads to it", () => {
    const el = mount(withRouter(<EndpointsList status="open" devices={[baseDevice({ id: "T", name: "tigez" })]} />));
    expect(el.querySelector('[data-testid="device-usb-T"]')?.getAttribute("href")).toBe("/d/usb-T");
    expect(el.querySelectorAll(".device-connections li")).toHaveLength(1);
    expect(el.querySelector('[data-testid="device-link-usb-T"]')?.textContent).toContain("USB · /dev/cu.usbmodemA · ID 0002");
    expect(el.querySelector('[data-testid="device-row-open-usb-T"]')).toBeNull();
  });
});

describe("relay card quick-connect and open arrows (OOP 2026-09-10)", () => {
  function relay(overrides: Partial<EndpointListEntry> = {}): EndpointListEntry {
    return {
      endpointId: "usb-RELAY-Q",
      transport: "usb",
      resourceKey: "usb-RELAY-Q",
      classification: { type: "relay", role: "RADIORELAY", commonName: "relay", dialect: "space", evidence: "role", program: null, version: null },
      name: "rly01",
      role: "RADIORELAY",
      sessionOpen: true,
      usb: { serialNumber: "RELAY-Q-FULL", displaySerial: "0009", port: "/dev/cu.usbmodemQ" },
      ...overrides,
    };
  }

  it("a relay card carries a robot picker and Connect that reports the picked name without opening the relay page", () => {
    const connects: Array<[string, string]> = [];
    const el = mount(
      withRouter(
        <EndpointsList
          status="open"
          devices={[relay()]}
          robotOptions={[{ name: "vevav", discoveredOnly: false }, { name: "gopiv", discoveredOnly: true }]}
          onRelayConnect={(endpoint, name) => connects.push([endpoint.endpointId, name])}
        />,
      ),
    );
    const select = el.querySelector<HTMLSelectElement>('[data-testid="relay-quick-connect-usb-RELAY-Q"] select');
    expect(select).not.toBeNull();
    expect(Array.from(select!.options).map((o) => o.textContent)).toEqual(["Choose a robot…", "vevav", "gopiv (on the network)"]);
    act(() => {
      select!.value = "vevav";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const connect = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Connect");
    act(() => {
      connect!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(connects).toEqual([["usb-RELAY-Q", "vevav"]]);
    expect(el.querySelector('[data-testid="location"]')?.textContent).toBe("/");
  });

  it("with a child already connected the relay card says so and offers Switch/Disconnect", () => {
    const disconnects: string[] = [];
    const child: EndpointListEntry = {
      endpointId: "usb-RELAY-Q-via-vevav",
      transport: "relay-radio",
      resourceKey: "usb-RELAY-Q",
      classification: { type: "robot", role: "NEZHA2", commonName: "robot", dialect: "space", evidence: "role", program: null, version: null },
      name: "vevav",
      role: "NEZHA2",
      sessionOpen: true,
      viaRelay: { relayEndpointId: "usb-RELAY-Q", robotName: "vevav", channel: 55, group: 114 },
    };
    const el = mount(
      withRouter(
        <EndpointsList
          status="open"
          devices={[relay({ sessionOpen: false }), child]}
          robotOptions={[{ name: "vevav", discoveredOnly: false }]}
          onRelayDisconnect={(endpoint) => disconnects.push(endpoint.endpointId)}
        />,
      ),
    );
    const quick = el.querySelector('[data-testid="relay-quick-connect-usb-RELAY-Q"]');
    expect(quick?.textContent).toContain("Connected to vevav on channel 55, group 114");
    expect(quick?.querySelector<HTMLSelectElement>("select")?.value).toBe("vevav");
    const disconnect = Array.from(quick?.querySelectorAll("button") ?? []).find((b) => b.textContent === "Disconnect");
    act(() => {
      disconnect!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(disconnects).toEqual(["usb-RELAY-Q-via-vevav"]);
    // The robot reached through the relay is its own card, listing the radio link.
    expect(el.querySelector('[data-testid="device-link-usb-RELAY-Q-via-vevav"]')?.textContent).toContain("Radio via relay rly01");
  });

  it("FrontPage wires Connect with no pick to a session-open autoRobot request", () => {
    let socket: FakeSocket | null = null;
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
          <AppRoutes />
        </WsProvider>,
      ),
    );
    act(() => {
      socket!.emitOpen();
    });
    act(() => {
      socket!.emitMessage({ type: "endpoints", endpoints: [relay()] });
    });
    const connect = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Connect");
    expect(connect).toBeDefined();
    act(() => {
      connect!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(socket!.sent).toEqual([JSON.stringify({ type: "session-open", endpointId: "usb-RELAY-Q", autoRobot: true })]);
    expect(el.querySelector('[data-testid="location"]')?.textContent).toBe("/");
  });
});

describe("relay card relayBridge connecting/connected/failed states (sprint 013 ticket 003)", () => {
  function relay(overrides: Partial<EndpointListEntry> = {}): EndpointListEntry {
    return {
      endpointId: "usb-RELAY-R",
      transport: "usb",
      resourceKey: "usb-RELAY-R",
      classification: { type: "relay", role: "RADIORELAY", commonName: "relay", dialect: "space", evidence: "role", program: null, version: null },
      name: "rly02",
      role: "RADIORELAY",
      sessionOpen: true,
      usb: { serialNumber: "RELAY-R-FULL", displaySerial: "0010", port: "/dev/cu.usbmodemR" },
      ...overrides,
    };
  }

  it("renders 'Connecting to <name>…' as soon as relayBridge.state is 'connecting', with no child endpoint present", () => {
    const el = mount(
      withRouter(
        <EndpointsList
          status="open"
          devices={[relay({ relayBridge: { state: "connecting", robotName: "GoPiv" } })]}
          robotOptions={[{ name: "GoPiv", discoveredOnly: false }]}
        />,
      ),
    );
    const quick = el.querySelector('[data-testid="relay-quick-connect-usb-RELAY-R"]');
    expect(quick?.textContent).toContain("Connecting to GoPiv…");
  });

  it("renders the no-pick equivalent when relayBridge.state is 'connecting' with no robotName (default failover)", () => {
    const el = mount(
      withRouter(<EndpointsList status="open" devices={[relay({ relayBridge: { state: "connecting" } })]} />),
    );
    const quick = el.querySelector('[data-testid="relay-quick-connect-usb-RELAY-R"]');
    expect(quick?.textContent).toContain("Trying remembered robots…");
  });

  it("renders the failure reason from relayBridge.error when relayBridge.state is 'failed'", () => {
    const el = mount(
      withRouter(
        <EndpointsList
          status="open"
          devices={[
            relay({
              relayBridge: {
                state: "failed",
                robotName: "GoPiv",
                triedNames: ["GoPiv"],
                error: "GoPiv did not respond on any known address",
              },
            }),
          ]}
        />,
      ),
    );
    const quick = el.querySelector('[data-testid="relay-quick-connect-usb-RELAY-R"]');
    expect(quick?.textContent).toContain("GoPiv did not respond on any known address");
    // The relay's own connect row is still usable after a failure, not disabled/hidden.
    expect(quick?.querySelector("button")).not.toBeNull();
  });

  it("connectionState's Linked/Unreachable/Not linked text is identical whether relayBridge is absent, connecting, or failed", () => {
    const linkedTextFor = (overrides: Partial<EndpointListEntry>): string | null => {
      if (root) {
        act(() => {
          root!.unmount();
        });
      }
      if (container) {
        container.remove();
      }
      const el = mount(withRouter(<EndpointsList status="open" devices={[relay(overrides)]} />));
      return el.querySelector('[data-testid="device-link-usb-RELAY-R"] .device-connection-state')?.textContent ?? null;
    };
    expect(linkedTextFor({})).toBe("Linked");
    expect(linkedTextFor({ relayBridge: { state: "connecting", robotName: "GoPiv" } })).toBe("Linked");
    expect(linkedTextFor({ relayBridge: { state: "failed", error: "boom" } })).toBe("Linked");
  });

  it("on success (relayBridge cleared, child present) the robot reached through the relay appears as its own card listing 'Radio via relay <relay name>' and 'Linked'", () => {
    const child: EndpointListEntry = {
      endpointId: "usb-RELAY-R-via-gopiv",
      transport: "relay-radio",
      resourceKey: "usb-RELAY-R",
      classification: { type: "robot", role: "NEZHA2", commonName: "robot", dialect: "space", evidence: "role", program: null, version: null },
      name: "gopiv",
      role: "NEZHA2",
      sessionOpen: true,
      viaRelay: { relayEndpointId: "usb-RELAY-R", robotName: "gopiv", channel: 12, group: 3 },
    };
    // relayBridge is absent here -- ticket 002's contract clears it in the
    // same snapshot that introduces the child (see wsMessages.ts's
    // relayBridge doc comment).
    const el = mount(withRouter(<EndpointsList status="open" devices={[relay(), child]} />));

    // The relay's own card still says "Connected to <name>", not "Linked" alone.
    const quick = el.querySelector('[data-testid="relay-quick-connect-usb-RELAY-R"]');
    expect(quick?.textContent).toContain("Connected to gopiv on channel 12, group 3");
    expect(quick?.querySelector(".device-relay-connecting")).toBeNull();
    expect(quick?.querySelector(".device-relay-failed")).toBeNull();

    // The robot connected through the relay is its own device-list card.
    const childCard = el.querySelector('[data-testid="device-card-usb-RELAY-R-via-gopiv"]');
    expect(childCard).not.toBeNull();
    const childRow = childCard?.querySelector('[data-testid="device-link-usb-RELAY-R-via-gopiv"]');
    expect(childRow?.querySelector(".device-connection-label")?.textContent).toBe("Radio via relay rly02");
    expect(childRow?.querySelector(".device-connection-state")?.textContent).toBe("Linked");
  });
});
