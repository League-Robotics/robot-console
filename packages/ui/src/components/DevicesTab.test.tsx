// @vitest-environment jsdom
/**
 * DevicesTab.test.tsx — component-level tests for the Devices tab
 * (ticket 010 / SUC-001).
 *
 * Two layers, matching the ticket's testing note:
 *  - `DevicesList` (presentational) is exercised directly against
 *    plain `EndpointListEntry` data shaped exactly like a `type:
 *    'devices'` WebSocket message's payload -- normal row rendering,
 *    the unnamed/error flag, and the unresponsive-device case.
 *  - One test drives the real `WsProvider` against a fully synthetic
 *    fake socket (see `WebSocketLike`) and pushes an actual `{type:
 *    'devices', ...}` JSON message through it, proving the live
 *    "no manual refresh" wiring end to end.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type {
  EndpointListEntry,
  FirmwareAvailability,
  FirmwareKind,
} from "@robot-console/host/src/wsMessages.js";
import { DevicesList, DevicesTab } from "./DevicesTab";
import { WsProvider } from "../ws/WsProvider";
import { FakeSocket } from "../testing/FakeSocket";

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

/** Convenience shape for fixture construction: a flatter, pre-sprint-4
 * -like set of fields (`id`/`serialNumber`/`displaySerial`/`port`/
 * `linkOpen`/`linkError`) that {@link baseDevice} translates into the
 * real, reshaped {@link EndpointListEntry} -- so the ~20 call sites
 * below didn't all need to learn the new nested `usb`/`sessionOpen`/
 * `sessionError` shape individually. */
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
  flashStatus?: EndpointListEntry["flashStatus"];
}

/** A device's classification, derived from `role` the same way
 * `classifyBanner` would for these fixture roles -- good enough for
 * fixtures that never assert on `classification` directly (every
 * assertion in this file reads `role`/`sessionOpen`/`sessionError`, per
 * `DevicesList`'s own rendering, which never branches on
 * `classification`). */
function classificationFor(role: string | null): EndpointListEntry["classification"] {
  if (role === null) {
    return { type: "unknown", role: null, commonName: null, dialect: null, evidence: "none" };
  }
  if (role === "NEZHA2") {
    return { type: "robot", role, commonName: "robot", dialect: "space", evidence: "role" };
  }
  return { type: "unknown", role, commonName: null, dialect: null, evidence: "unrecognized" };
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
  if (overrides.flashStatus) {
    entry.flashStatus = overrides.flashStatus;
  }
  return entry;
}

/** A failed-identify device -- `role: null`, `sessionError` set -- the
 * only state per the sprint architecture that renders flash buttons. */
function failedIdentifyDevice(overrides: BaseDeviceOverrides = {}): EndpointListEntry {
  return baseDevice({
    id: "SERIAL-UNRESPONSIVE",
    name: "zeguz",
    role: null,
    linkOpen: false,
    linkError: "HELLO reply timed out after 2000ms",
    ...overrides,
  });
}

/** Firmware status matching the real, verified `pxt-nezha-diffdrive`
 * zero-release state (relay available, robot not) per sprint.md's
 * Success Criteria fixture. */
function firmwareStatusFixture(
  overrides: Partial<Record<FirmwareKind, FirmwareAvailability>> = {},
): Record<FirmwareKind, FirmwareAvailability> {
  return {
    relay: {
      configured: true,
      repoUrl: "https://github.com/League-Robotics/microbit-radio-relay",
      tag: "v0.20260831.1",
      available: true,
    },
    robot: {
      configured: true,
      repoUrl: "https://github.com/League-Robotics/pxt-nezha-diffdrive",
      tag: "latest",
      available: false,
      reason: "no-releases",
    },
    ...overrides,
  };
}

describe("DevicesList", () => {
  it("renders a normal device row with name, role, port, and device id", () => {
    const el = mount(
      <DevicesList
        status="open"
        devices={[baseDevice()]}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );

    const text = el.textContent ?? "";
    expect(text).toContain("zeguz");
    expect(text).toContain("NEZHA2");
    expect(text).toContain("/dev/cu.usbmodemA");
    expect(text).toContain("0002");
  });

  it("flags a device that failed SWD naming as unnamed/error, not omitted", () => {
    const el = mount(
      <DevicesList
        status="open"
        devices={[
          baseDevice({
            id: "SERIAL-B",
            name: null,
            role: null,
            nameError: { reason: "swd-attach-failed", message: "could not attach over SWD" },
          }),
        ]}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );

    const text = el.textContent ?? "";
    expect(text).toContain("Unnamed device");
    expect(text).toContain("could not attach over SWD");
    // Never omitted: the row itself must still be present.
    expect(el.querySelector('[data-testid="device-usb-SERIAL-B"]')).not.toBeNull();
  });

  it("shows a device that never replied to HELLO as unresponsive, not assigned a role", () => {
    const el = mount(
      <DevicesList
        status="open"
        devices={[
          baseDevice({
            id: "SERIAL-C",
            role: null,
            linkOpen: false,
            linkError: "HELLO reply timed out after 2000ms",
          }),
        ]}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );

    const text = el.textContent ?? "";
    expect(text).toContain("Unresponsive");
    expect(text).toContain("HELLO reply timed out after 2000ms");
    // Must not show a raw role of null/"" nor a role token.
    expect(text).not.toContain("NEZHA2");
  });

  it("renders the realistic ground-truth board (name only, role null, silent link error) legibly", () => {
    const el = mount(
      <DevicesList
        status="open"
        devices={[
          baseDevice({
            id: "9906360200052820aba2e384f40cfd6c000000006e052820",
            serialNumber: "9906360200052820aba2e384f40cfd6c000000006e052820",
            displaySerial: "052820aba2e384f40cfd6c0",
            name: "zeguz",
            role: null,
            port: "/dev/cu.usbmodem2121102",
            linkOpen: false,
            linkError: "HELLO reply timed out after 2000ms",
          }),
        ]}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );

    const text = el.textContent ?? "";
    expect(text).toContain("zeguz");
    expect(text).toContain("Unresponsive");
    expect(text).toContain("/dev/cu.usbmodem2121102");
    // The displaySerial (unique middle field) is shown, not a truncated
    // prefix/suffix of the full serial that two boards could share.
    expect(text).toContain("052820aba2e384f40cfd6c0");
  });

  it("shows a device with no serial port as connectable-by-nothing rather than a broken button", () => {
    const el = mount(
      <DevicesList
        status="open"
        devices={[baseDevice({ id: "SERIAL-D", port: null, linkOpen: false })]}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );

    expect(el.textContent ?? "").toContain("No serial port available to connect");
    expect(el.querySelector("button")).toBeNull();
  });

  it("shows a reconnecting banner without dropping the last-known device list", () => {
    const el = mount(
      <DevicesList
        status="closed"
        devices={[baseDevice()]}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );

    const text = el.textContent ?? "";
    expect(text).toContain("reconnecting");
    expect(text).toContain("zeguz");
  });

  it("sends an open message when Connect is clicked on a closed device with a port", () => {
    const opened: string[] = [];
    const el = mount(
      <DevicesList
        status="open"
        devices={[baseDevice({ id: "SERIAL-E", linkOpen: false })]}
        onOpen={(id) => opened.push(id)}
        onClose={() => {}}
      />,
    );

    const button = el.querySelector("button");
    expect(button?.textContent).toBe("Connect");
    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(opened).toEqual(["usb-SERIAL-E"]);
  });

  it("sends a close message when Disconnect is clicked on an open device", () => {
    const closed: string[] = [];
    const el = mount(
      <DevicesList
        status="open"
        devices={[baseDevice({ id: "SERIAL-F", linkOpen: true })]}
        onOpen={() => {}}
        onClose={(id) => closed.push(id)}
      />,
    );

    const button = el.querySelector("button");
    expect(button?.textContent).toBe("Disconnect");
    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(closed).toEqual(["usb-SERIAL-F"]);
  });

  it("shows no flash buttons for an identified device", () => {
    const el = mount(
      <DevicesList
        status="open"
        devices={[baseDevice({ id: "SERIAL-IDENTIFIED", role: "NEZHA2" })]}
        firmwareStatus={firmwareStatusFixture()}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );

    expect(el.textContent ?? "").not.toContain("Flash relay firmware");
    expect(el.textContent ?? "").not.toContain("Flash robot firmware");
  });

  it("shows no flash buttons for an unprobed device (no role, no linkError)", () => {
    const el = mount(
      <DevicesList
        status="open"
        devices={[baseDevice({ id: "SERIAL-UNPROBED", role: null, linkOpen: false })]}
        firmwareStatus={firmwareStatusFixture()}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );

    expect(el.textContent ?? "").not.toContain("Flash relay firmware");
    expect(el.textContent ?? "").not.toContain("Flash robot firmware");
  });

  it("shows both flash buttons for a failed-identify device", () => {
    const el = mount(
      <DevicesList
        status="open"
        devices={[failedIdentifyDevice()]}
        firmwareStatus={firmwareStatusFixture()}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );

    const text = el.textContent ?? "";
    expect(text).toContain("Flash relay firmware");
    expect(text).toContain("Flash robot firmware");
  });

  it("disables the robot button with a readable reason on the zero-release fixture", () => {
    const el = mount(
      <DevicesList
        status="open"
        devices={[failedIdentifyDevice()]}
        firmwareStatus={firmwareStatusFixture()}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );

    const buttons = Array.from(el.querySelectorAll("button"));
    const robotButton = buttons.find((b) => b.textContent === "Flash robot firmware");
    expect(robotButton?.disabled).toBe(true);
    expect(el.textContent ?? "").toContain("No build has been published yet");
  });

  it("enables the relay button when its release is available", () => {
    const el = mount(
      <DevicesList
        status="open"
        devices={[failedIdentifyDevice()]}
        firmwareStatus={firmwareStatusFixture()}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );

    const buttons = Array.from(el.querySelectorAll("button"));
    const relayButton = buttons.find((b) => b.textContent === "Flash relay firmware");
    expect(relayButton?.disabled).toBe(false);
  });

  it("flips the robot button to enabled with no code change when availability flips", () => {
    const el = mount(
      <DevicesList
        status="open"
        devices={[failedIdentifyDevice()]}
        firmwareStatus={firmwareStatusFixture({
          robot: {
            configured: true,
            repoUrl: "https://github.com/League-Robotics/pxt-nezha-diffdrive",
            tag: "latest",
            available: true,
          },
        })}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );

    const buttons = Array.from(el.querySelectorAll("button"));
    const robotButton = buttons.find((b) => b.textContent === "Flash robot firmware");
    expect(robotButton?.disabled).toBe(false);
  });

  it("shows a not-broken message before the first availability poll completes", () => {
    const el = mount(
      <DevicesList
        status="open"
        devices={[failedIdentifyDevice()]}
        firmwareStatus={firmwareStatusFixture({
          robot: {
            configured: true,
            repoUrl: "https://github.com/League-Robotics/pxt-nezha-diffdrive",
            tag: "latest",
            available: false,
            reason: "not-yet-checked",
          },
        })}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );

    expect(el.textContent ?? "").toContain("Checking whether this firmware is available");
  });

  it("sends a flash-start message when Flash relay firmware is clicked", () => {
    const sent: Array<{ endpointId: string; firmware: FirmwareKind }> = [];
    const el = mount(
      <DevicesList
        status="open"
        devices={[failedIdentifyDevice({ id: "SERIAL-FLASH" })]}
        firmwareStatus={firmwareStatusFixture()}
        onOpen={() => {}}
        onClose={() => {}}
        onFlash={(endpointId, firmware) => sent.push({ endpointId, firmware })}
      />,
    );

    const buttons = Array.from(el.querySelectorAll("button"));
    const relayButton = buttons.find((b) => b.textContent === "Flash relay firmware");
    act(() => {
      relayButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(sent).toEqual([{ endpointId: "usb-SERIAL-FLASH", firmware: "relay" }]);
  });

  it("hides both flash buttons and shows phase-derived progress while flashStatus is set", () => {
    const el = mount(
      <DevicesList
        status="open"
        devices={[
          failedIdentifyDevice({
            flashStatus: { firmware: "relay", phase: "writing" },
          }),
        ]}
        firmwareStatus={firmwareStatusFixture()}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );

    const text = el.textContent ?? "";
    expect(text).not.toContain("Flash relay firmware");
    expect(text).not.toContain("Flash robot firmware");
    expect(text).toContain("Flashing relay firmware: writing…");
  });

  it("surfaces a terminal flash-result error's message", () => {
    const el = mount(
      <DevicesList
        status="open"
        devices={[failedIdentifyDevice()]}
        firmwareStatus={firmwareStatusFixture()}
        flashErrors={{ "usb-SERIAL-UNRESPONSIVE": "sha256 mismatch on downloaded hex" }}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );

    expect(el.textContent ?? "").toContain("sha256 mismatch on downloaded hex");
  });
});

describe("WsProvider end-to-end wiring", () => {
  it("renders a live 'devices' message pushed over the socket, with no manual refresh", () => {
    let socket: FakeSocket | null = null;
    const el = mount(
      <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
        <DevicesTabProbe />
      </WsProvider>,
    );

    expect(socket).not.toBeNull();
    act(() => {
      socket!.emitOpen();
    });
    expect(el.textContent).toContain("No devices detected yet");

    act(() => {
      socket!.emitMessage({
        type: "endpoints",
        endpoints: [baseDevice({ id: "SERIAL-LIVE", name: "kivon" })],
      });
    });

    expect(el.textContent).toContain("kivon");
  });

  it("sends a well-formed flash-start message when a flash button is clicked through the live socket", () => {
    let socket: FakeSocket | null = null;
    const el = mount(
      <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
        <DevicesTabProbe />
      </WsProvider>,
    );

    act(() => {
      socket!.emitOpen();
    });
    act(() => {
      socket!.emitMessage({
        type: "endpoints",
        endpoints: [
          baseDevice({
            id: "SERIAL-LIVE-FLASH",
            name: "kivon",
            role: null,
            linkOpen: false,
            linkError: "HELLO reply timed out after 2000ms",
          }),
        ],
        firmwareStatus: firmwareStatusFixture(),
      });
    });

    const relayButton = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "Flash relay firmware",
    );
    act(() => {
      relayButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(socket!.sent).toEqual([
      JSON.stringify({
        type: "flash-start",
        endpointId: "usb-SERIAL-LIVE-FLASH",
        source: { kind: "release", firmware: "relay" },
      }),
    ]);
  });

  it("surfaces a live flash-result error pushed over the socket, fanned out independently of who clicked", () => {
    let socket: FakeSocket | null = null;
    const el = mount(
      <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
        <DevicesTabProbe />
      </WsProvider>,
    );

    act(() => {
      socket!.emitOpen();
    });
    act(() => {
      socket!.emitMessage({
        type: "endpoints",
        endpoints: [
          baseDevice({
            id: "SERIAL-LIVE-ERROR",
            name: "kivon",
            role: null,
            linkOpen: false,
            linkError: "HELLO reply timed out after 2000ms",
          }),
        ],
        firmwareStatus: firmwareStatusFixture(),
      });
    });

    // No click from this client -- proves the error surfaces purely from
    // the server's fan-out broadcast, per every connected tab seeing it.
    act(() => {
      socket!.emitMessage({
        type: "flash-result",
        endpointId: "usb-SERIAL-LIVE-ERROR",
        source: { kind: "release", firmware: "relay" },
        status: "error",
        message: "sha256 mismatch on downloaded hex",
      });
    });

    expect(el.textContent ?? "").toContain("sha256 mismatch on downloaded hex");
  });
});

// Local probe component: exercises the real connected `DevicesTab`
// (which reads `WsProvider`'s selector hooks), rather than
// re-testing `DevicesList` again.
function DevicesTabProbe() {
  return <DevicesTab />;
}
