// @vitest-environment jsdom
/**
 * RelayPage.test.tsx — tests for the relay page's real connect/
 * connected behavior (rewritten out-of-process, 2026-09-09, replacing
 * the earlier "empty shell" placeholder-era assertions -- see
 * `RelayPage.tsx`'s own doc comment for the host contract this now
 * exercises: `session-open { endpointId, robotName, radio }` and the
 * `viaRelay`-carrying child endpoint the host publishes once tuned).
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type {
  DiscoveredServicesSnapshot,
  EndpointListEntry,
  RememberedRobotEntry,
} from "@robot-console/host/src/wsMessages.js";
import { nameToRadioAddress } from "@robot-console/protocol";
import { RelayPage } from "./RelayPage";
import { AppHeader } from "../components/AppHeader";
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
  try {
    window.localStorage.clear();
  } catch {
    // jsdom always has localStorage, but mirror the page's own
    // best-effort handling rather than assuming.
  }
});

function relayFixture(overrides: Partial<EndpointListEntry> = {}): EndpointListEntry {
  return {
    endpointId: "usb-RELAY-A",
    transport: "usb",
    resourceKey: "usb-RELAY-A",
    classification: { type: "relay", role: "RADIORELAY", commonName: "relay", dialect: "space", evidence: "role" },
    name: "gopiv",
    role: "RADIORELAY",
    sessionOpen: true,
    usb: { serialNumber: "RELAY-A-FULL", displaySerial: "0003", port: "/dev/cu.usbmodemB" },
    ...overrides,
  };
}

function childFixture(overrides: Partial<EndpointListEntry> = {}): EndpointListEntry {
  return {
    endpointId: "usb-RELAY-A-via-vevav",
    transport: "relay-radio",
    resourceKey: "usb-RELAY-A",
    classification: { type: "robot", role: "NEZHA2", commonName: "robot", dialect: "space", evidence: "role" },
    name: "vevav",
    role: "NEZHA2",
    sessionOpen: true,
    viaRelay: { relayEndpointId: "usb-RELAY-A", robotName: "vevav", channel: 55, group: 114 },
    ...overrides,
  };
}

function rememberedRobotFixture(name: string): RememberedRobotEntry {
  return {
    name,
    lastSeenAt: "2026-01-01T12:34:00.000Z",
    lastSeenVia: "usb",
    lastRole: "NEZHA2",
    lastUsbSerial: `${name}-SERIAL`,
  };
}

const NO_FIRMWARE_STATUS = {
  relay: { configured: false as const },
  robot: { configured: false as const },
};

const NO_DISCOVERED_SERVICES: DiscoveredServicesSnapshot = { relays: [], robots: [] };

function mountRelayPage(
  endpoint: EndpointListEntry,
  options: {
    rememberedRobots?: RememberedRobotEntry[];
    endpoints?: EndpointListEntry[];
    discoveredServices?: DiscoveredServicesSnapshot;
  } = {},
): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <RelayPage endpoint={endpoint} />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  act(() => {
    socket!.emitMessage({
      type: "endpoints",
      endpoints: options.endpoints ?? [endpoint],
      firmwareStatus: NO_FIRMWARE_STATUS,
      rememberedRobots: options.rememberedRobots ?? [],
      discoveredServices: options.discoveredServices ?? NO_DISCOVERED_SERVICES,
    });
  });
  return { el, socket: socket! };
}

/** Re-emit a fresh `endpoints` snapshot on an already-mounted page's
 * socket -- used to drive a mid-test transition (e.g. a default-failover
 * attempt's child appearing, or a host error line arriving) without
 * remounting, since remounting would lose the page's own in-flight
 * "trying" state. */
function emitEndpoints(
  socket: FakeSocket,
  endpoints: EndpointListEntry[],
  options: { rememberedRobots?: RememberedRobotEntry[]; discoveredServices?: DiscoveredServicesSnapshot } = {},
): void {
  act(() => {
    socket.emitMessage({
      type: "endpoints",
      endpoints,
      firmwareStatus: NO_FIRMWARE_STATUS,
      rememberedRobots: options.rememberedRobots ?? [],
      discoveredServices: options.discoveredServices ?? NO_DISCOVERED_SERVICES,
    });
  });
}

function select(el: HTMLDivElement): HTMLSelectElement {
  return el.querySelector<HTMLSelectElement>('[data-testid="relay-robot-select"]')!;
}

function channelInput(el: HTMLDivElement): HTMLInputElement {
  return el.querySelector<HTMLInputElement>('[data-testid="relay-channel"]')!;
}

function groupInput(el: HTMLDivElement): HTMLInputElement {
  return el.querySelector<HTMLInputElement>('[data-testid="relay-group"]')!;
}

function connectButton(el: HTMLDivElement): HTMLButtonElement {
  return el.querySelector<HTMLButtonElement>('[data-testid="relay-connect"]')!;
}

function setSelectValue(el: HTMLSelectElement, value: string): void {
  act(() => {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    nativeSetter.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function setInputValue(el: HTMLInputElement, value: string): void {
  act(() => {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    nativeSetter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("RelayPage -- not connected", () => {
  it("renders a header with the relay's name", () => {
    const { el } = mountRelayPage(relayFixture());
    expect(el.textContent).toContain("gopiv");
  });

  it("renders the robot select from the remembered-robot roster, sorted", () => {
    const { el } = mountRelayPage(relayFixture(), {
      rememberedRobots: [rememberedRobotFixture("zeguz"), rememberedRobotFixture("bavon")],
    });
    const options = Array.from(select(el).options).map((o) => o.value).filter((v) => v !== "");
    expect(options).toEqual(["bavon", "zeguz"]);
    expect(select(el).options[0]!.textContent).toBe("Choose a robot…");
  });

  it("shows a disabled placeholder and hint when the roster is empty", () => {
    const { el } = mountRelayPage(relayFixture(), { rememberedRobots: [] });
    const sel = select(el);
    expect(sel.disabled).toBe(true);
    expect(sel.options).toHaveLength(1);
    expect(sel.textContent).toContain("No robots remembered yet — connect one over USB once");
  });

  it("prefills channel/group from the name-derived address on selection", () => {
    const { el } = mountRelayPage(relayFixture(), { rememberedRobots: [rememberedRobotFixture("vevav")] });
    setSelectValue(select(el), "vevav");
    const derived = nameToRadioAddress("vevav");
    expect(channelInput(el).valueAsNumber).toBe(derived.channel);
    expect(groupInput(el).valueAsNumber).toBe(derived.group);
  });

  it("enables Connect with no selection -- ticket 005: no pick is the default-failover trigger, not a disabled state", () => {
    const { el } = mountRelayPage(relayFixture(), { rememberedRobots: [rememberedRobotFixture("vevav")] });
    expect(connectButton(el).disabled).toBe(false);
  });

  it("disables Connect when the relay itself is not attached and no child exists", () => {
    const { el } = mountRelayPage(relayFixture({ sessionOpen: false }), {
      rememberedRobots: [rememberedRobotFixture("vevav")],
    });
    setSelectValue(select(el), "vevav");
    expect(connectButton(el).disabled).toBe(true);
  });

  it("clicking Connect with no selection sends session-open with autoRobot: true and no robotName/radio (ticket 005 default failover)", () => {
    const { el, socket } = mountRelayPage(relayFixture(), { rememberedRobots: [rememberedRobotFixture("vevav")] });

    act(() => {
      connectButton(el).click();
    });

    expect(socket.sent).toEqual([
      JSON.stringify({ type: "session-open", endpointId: "usb-RELAY-A", autoRobot: true }),
    ]);
  });

  it("shows a transient 'trying' status while a no-pick Connect is outstanding, cleared once a host error for this relay arrives", () => {
    const relay = relayFixture();
    const { el, socket } = mountRelayPage(relay, { rememberedRobots: [rememberedRobotFixture("vevav")] });

    act(() => {
      connectButton(el).click();
    });
    expect(el.querySelector('[data-testid="relay-autoconnecting"]')).not.toBeNull();

    // deviceRegistry.ts's openRobotViaRelay reports failover exhaustion
    // via emitError -- WsProvider.appendHostError lands that in this
    // relay's own console log as an origin: "host" entry, which is what
    // this page actually watches (see RelayPage.tsx's own doc comment).
    emitEndpoints(socket, [relay]);
    act(() => {
      socket.emitMessage({ type: "error", endpointId: relay.endpointId, message: "gave up on every candidate" });
    });

    expect(el.querySelector('[data-testid="relay-autoconnecting"]')).toBeNull();
  });

  it("lists discovered-only mbserial names alongside the roster, marked '(on the network)'", () => {
    const { el } = mountRelayPage(relayFixture(), {
      rememberedRobots: [rememberedRobotFixture("bavon")],
      discoveredServices: { relays: [], robots: [{ instanceName: "gopiv", host: "gopiv.local", port: 8760 }] },
    });
    const options = Array.from(select(el).options);
    const texts = options.map((o) => o.textContent);
    expect(texts).toContain("bavon");
    expect(texts).toContain("gopiv (on the network)");
  });

  it("a name in both the roster and discovery is listed once, plain (not marked discovered-only)", () => {
    const { el } = mountRelayPage(relayFixture(), {
      rememberedRobots: [rememberedRobotFixture("gopiv")],
      discoveredServices: { relays: [], robots: [{ instanceName: "gopiv", host: "gopiv.local", port: 8760 }] },
    });
    const values = Array.from(select(el).options).map((o) => o.value).filter((v) => v !== "");
    expect(values).toEqual(["gopiv"]);
    expect(select(el).textContent).toContain("gopiv");
    expect(select(el).textContent).not.toContain("gopiv (on the network)");
  });

  it("never sends anything but session-open, and only after Connect is clicked -- rendering and opening the dropdown sends nothing", () => {
    const { el, socket } = mountRelayPage(relayFixture(), {
      rememberedRobots: [rememberedRobotFixture("vevav"), rememberedRobotFixture("bavon")],
      discoveredServices: { relays: [], robots: [{ instanceName: "gopiv", host: "gopiv.local", port: 8760 }] },
    });

    setSelectValue(select(el), "vevav");
    setSelectValue(select(el), "gopiv");
    setSelectValue(select(el), "");

    expect(socket.sent).toEqual([]);

    act(() => {
      connectButton(el).click();
    });
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!).type).toBe("session-open");
  });

  it("editing the address to 55/114 and clicking Connect sends exactly one session-open with those values", () => {
    const { el, socket } = mountRelayPage(relayFixture(), { rememberedRobots: [rememberedRobotFixture("vevav")] });
    setSelectValue(select(el), "vevav");
    setInputValue(channelInput(el), "55");
    setInputValue(groupInput(el), "114");
    act(() => {
      connectButton(el).click();
    });

    expect(socket.sent).toEqual([
      JSON.stringify({
        type: "session-open",
        endpointId: "usb-RELAY-A",
        robotName: "vevav",
        radio: { channel: 55, group: 114 },
      }),
    ]);
  });

  it("remembers an edited address for a name in localStorage once connected, and reapplies it on reselect", () => {
    const { el } = mountRelayPage(relayFixture(), { rememberedRobots: [rememberedRobotFixture("vevav")] });
    setSelectValue(select(el), "vevav");
    setInputValue(channelInput(el), "55");
    setInputValue(groupInput(el), "114");
    act(() => {
      connectButton(el).click();
    });

    expect(window.localStorage.getItem("robot-console:relay-address:vevav")).toBe(
      JSON.stringify({ channel: 55, group: 114 }),
    );

    // A fresh mount, then re-selecting the same name should read the
    // stored override rather than the plain name-derived default.
    const { el: el2 } = mountRelayPage(relayFixture(), { rememberedRobots: [rememberedRobotFixture("vevav")] });
    setSelectValue(select(el2), "vevav");
    expect(channelInput(el2).valueAsNumber).toBe(55);
    expect(groupInput(el2).valueAsNumber).toBe(114);
  });

  it("renders the relay's own device console", () => {
    const { el } = mountRelayPage(relayFixture());
    expect(el.querySelector('[aria-label="Console"]')).not.toBeNull();
  });
});

describe("RelayPage -- connected", () => {
  it("renders the connected status line", () => {
    const relay = relayFixture({ sessionOpen: false });
    const child = childFixture();
    const { el } = mountRelayPage(relay, { endpoints: [relay, child] });

    const status = el.querySelector('[data-testid="relay-connected"]');
    expect(status).not.toBeNull();
    expect(status!.textContent).toBe("Connected to vevav via gopiv on channel 55, group 114");
  });

  it("renders RobotPage for the child endpoint", () => {
    const relay = relayFixture({ sessionOpen: false });
    const child = childFixture();
    const { el } = mountRelayPage(relay, { endpoints: [relay, child] });

    expect(el.querySelector('[data-testid="estop-button"]')).not.toBeNull();
  });

  it("does not render the relay's own console while connected", () => {
    const relay = relayFixture({ sessionOpen: false });
    const child = childFixture();
    const { el } = mountRelayPage(relay, { endpoints: [relay, child] });

    // RobotPage mounts its own DeviceConsole (aria-label "Console") for
    // the child -- exactly one such region should exist, not two.
    expect(el.querySelectorAll('[aria-label="Console"]')).toHaveLength(1);
  });

  it("clicking Disconnect sends session-close for the child", () => {
    const relay = relayFixture({ sessionOpen: false });
    const child = childFixture();
    const { el, socket } = mountRelayPage(relay, { endpoints: [relay, child] });
    // Mounting RobotPage for the child auto-fires its own on-open
    // traffic (StatusPanel's STATUS, CommandStrip's GET) -- clear that
    // background noise so this assertion is only about what Disconnect
    // itself sends, mirroring CommandStrip.test.tsx's own convention.
    socket.sent.length = 0;

    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="relay-disconnect"]')!.click();
    });

    expect(socket.sent).toEqual([JSON.stringify({ type: "session-close", endpointId: "usb-RELAY-A-via-vevav" })]);
  });

  it("switching to a different robot sends session-close then session-open, in that order", () => {
    const relay = relayFixture({ sessionOpen: false });
    const child = childFixture();
    const { el, socket } = mountRelayPage(relay, {
      endpoints: [relay, child],
      rememberedRobots: [rememberedRobotFixture("vevav"), rememberedRobotFixture("zeguz")],
    });
    socket.sent.length = 0;

    setSelectValue(select(el), "zeguz");
    setInputValue(channelInput(el), "27");
    setInputValue(groupInput(el), "3");
    act(() => {
      connectButton(el).click();
    });

    expect(socket.sent).toEqual([
      JSON.stringify({ type: "session-close", endpointId: "usb-RELAY-A-via-vevav" }),
      JSON.stringify({
        type: "session-open",
        endpointId: "usb-RELAY-A",
        robotName: "zeguz",
        radio: { channel: 27, group: 3 },
      }),
    ]);
  });

  it("shows the child's sessionError as an alert", () => {
    const relay = relayFixture({ sessionOpen: false });
    const child = childFixture({ sessionError: "robot did not answer HELLO" });
    const { el } = mountRelayPage(relay, { endpoints: [relay, child] });

    const alert = el.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("robot did not answer HELLO");
  });

  it("mounts AddressSourceChip above RobotPage, fed from the child's own addressSource/viaRelay/transport", () => {
    const relay = relayFixture({ sessionOpen: false });
    const child = childFixture({ addressSource: "local-derived" });
    const { el } = mountRelayPage(relay, { endpoints: [relay, child] });

    const chip = el.querySelector('[data-testid="address-source-chip"]');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("ch 55 / grp 114");
    expect(chip!.textContent).toContain("derived (no registry)");

    // "Above RobotPage, never inside it": the chip must precede
    // RobotPage's own root element in document order, and RobotPage's
    // markup must not contain it (proving it isn't nested inside).
    const robotSection = el.querySelector('section.robot-page')!;
    expect(robotSection.contains(chip)).toBe(false);
    const position = chip!.compareDocumentPosition(robotSection);
    expect(Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it("marks the chip's registryWasConsidered from whether any _mbrelay._tcp service is currently discovered", () => {
    const relay = relayFixture({ sessionOpen: false });
    const child = childFixture({ addressSource: "local-derived" });
    const { el } = mountRelayPage(relay, {
      endpoints: [relay, child],
      discoveredServices: { relays: [{ instanceName: "torture", host: "torture.local", port: 8760 }], robots: [] },
    });

    const chip = el.querySelector('[data-testid="address-source-chip"]');
    expect(chip!.getAttribute("data-variant")).toBe("warning");
    expect(chip!.textContent).toContain("derived (registry unreachable)");
  });

  it("renders a visible failover trail (two given-up-on candidates, one success) via the chip, not hidden behind a disclosure", () => {
    const relay = relayFixture({ sessionOpen: false });
    const child = childFixture({
      addressSource: "local-derived",
      failoverTrail: [
        { name: "zeguz", transport: "relay-radio", reason: "no reply" },
        { name: "bavon", transport: "relay-radio", reason: "timeout" },
      ],
    });
    const { el } = mountRelayPage(relay, { endpoints: [relay, child] });

    const trail = el.querySelector('[data-testid="address-source-chip-trail"]');
    expect(trail).not.toBeNull();
    expect(trail!.textContent).toContain("gave up on zeguz (no reply)");
    expect(trail!.textContent).toContain("tried bavon (timeout)");
  });

  it("does not render the chip for an mbserial-transport child (no address-source concept)", () => {
    const relay = relayFixture({ sessionOpen: false });
    const child = childFixture({ transport: "mbserial" });
    const { el } = mountRelayPage(relay, { endpoints: [relay, child] });

    expect(el.querySelector('[data-testid="address-source-chip"]')).toBeNull();
  });
});

describe("RelayPage under AppHeader (ticket 012-004)", () => {
  // AppHeader owns the back-to-devices link and the Flash menu entry
  // (see AppHeader.test.tsx for the full behavior matrix); this is a
  // cheap per-page smoke test proving both actually show up on a real
  // relay device page's route, not just in AppHeader's own isolated
  // tests.
  it("shows a back-to-devices link and an enabled Flash entry alongside the relay page", () => {
    const relay = relayFixture();
    let socket: FakeSocket | null = null;
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
          <AppHeader />
          <RelayPage endpoint={relay} />
        </WsProvider>,
        { initialEntries: [`/d/${relay.endpointId}`] },
      ),
    );
    act(() => {
      socket!.emitOpen();
    });
    act(() => {
      socket!.emitMessage({
        type: "endpoints",
        endpoints: [relay],
        firmwareStatus: NO_FIRMWARE_STATUS,
        rememberedRobots: [],
      });
    });

    const backLink = el.querySelector("a");
    expect(backLink?.getAttribute("href")).toBe("/");
    const flashButton = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Flash");
    expect(flashButton).not.toBeUndefined();
    expect(flashButton?.disabled).toBe(false);
  });
});

describe("RelayPage width (OOP 2026-09-09)", () => {
  it("lifts its 46rem shell when a robot is on screen, so RobotPage gets the same full-width layout it gets on DevicePage", () => {
    const relay = relayFixture({ sessionOpen: false });
    const child = childFixture();
    const { el } = mountRelayPage(relay, { endpoints: [relay, child] });
    const section = el.querySelector("section.relay-page")!;
    expect(section.classList.contains("relay-page-connected")).toBe(true);
  });

  it("keeps the narrow shell when not connected", () => {
    const { el } = mountRelayPage(relayFixture());
    const section = el.querySelector("section.relay-page")!;
    expect(section.classList.contains("relay-page-connected")).toBe(false);
  });
});
