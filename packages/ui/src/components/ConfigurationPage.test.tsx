// @vitest-environment jsdom
/**
 * ConfigurationPage.test.tsx — ticket 018-013 added the "Calibration
 * firmware" flash/verify block, the calx/cala run buttons, and the
 * unfiltered `DeviceConsole` under "Code for your program"; a same-day
 * stakeholder correction ("put it under Calibrate") moved the firmware
 * block and the run buttons to `CalibrationPage.test.tsx`, leaving only
 * the `DeviceConsole` mount here. This page still takes `link` (see
 * `mountPage` below) -- now only to mount that console, not to flash or
 * run calx/cala.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SnapshotDevice, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { ConfigurationPage, MASKED_PASSWORD, configurationCode } from "./ConfigurationPage";
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

beforeEach(() => {
  window.localStorage.clear();
});

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

function robot(
  overrides: Partial<Omit<SnapshotDevice, "links">> = {},
  linkOverrides: Partial<SnapshotLink> = {},
): SnapshotDevice {
  return {
    id: 1198504156,
    name: "tigez",
    kind: "robot",
    role: "NEZHA2",
    commonName: null,
    program: null,
    version: null,
    owned: true,
    radio: { channel: 41, group: 3, source: "derived" },
    lastSeen: 0,
    lastChecked: null,
    links: [
      {
        id: "usb-ROBOT-A",
        transport: "usb",
        label: "USB · /dev/cu.usbmodemC",
        state: "connected",
        reason: null,
        since: 0,
        lastSeen: 0,
        nextRetryAt: null,
        capabilities: { open: false, close: true, flash: true, provisionWifi: true },
        session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null },
        ...linkOverrides,
      },
    ],
    ...overrides,
  };
}

function mountPage(
  overrides: Partial<Omit<SnapshotDevice, "links">> = {},
  linkOverrides: Partial<SnapshotLink> = {},
): { el: HTMLDivElement; socket: FakeSocket; device: SnapshotDevice } {
  let socket: FakeSocket | null = null;
  const device = robot(overrides, linkOverrides);
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <ConfigurationPage device={device} link={device.links[0]!} />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket!, device };
}

function type(el: HTMLDivElement, selector: string, value: string): void {
  const input = el.querySelector<HTMLInputElement>(selector)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function sent(socket: FakeSocket): unknown[] {
  return socket.sent.map((raw) => JSON.parse(raw));
}

describe("configurationCode", () => {
  it("emits radio, masked Wi-Fi, and calibration lines in that order", () => {
    const code = configurationCode({
      robotName: "tigez",
      radio: { channel: 55, group: 114 },
      wifi: { ssid: "Busboom_Garage", password: undefined },
      calibration: { wheelDiameterMm: 90.68 },
    });
    expect(code.split("\n")).toEqual([
      "// tigez configuration",
      "diffDrive.setupRadio(55, 114)  // radio channel, group",
      `diffDrive.setupWifi("Busboom_Garage", "${MASKED_PASSWORD}")  // password not known to this computer -- fill it in`,
      "diffDrive.setWheelCalibration(90.68 * Math.PI / 360)  // wheel diameter 90.68 mm",
    ]);
  });

  it("puts the real password in when revealed, quoting it as a JS string, and is empty with nothing to say", () => {
    expect(configurationCode({ robotName: "t", radio: undefined, wifi: { ssid: "Net", password: 'a"b' }, calibration: {} })).toContain(
      'diffDrive.setupWifi("Net", "a\\"b")',
    );
    expect(configurationCode({ robotName: "t", radio: undefined, wifi: undefined, calibration: {} })).toBe("");
  });
});

describe("ConfigurationPage", () => {
  it("asks the host for the network with the password, shows both in the fields, and puts them in the code", () => {
    const { el, socket } = mountPage();
    expect(sent(socket)).toEqual([{ type: "get-wifi-credentials", reveal: true }]);
    act(() => {
      socket.emitMessage({ type: "wifi-credentials", ssid: "Busboom_Garage", hasPassword: true, source: "stored", password: "hunter2" });
    });
    expect(el.querySelector<HTMLInputElement>('[data-testid="configuration-wifi-ssid"]')!.value).toBe("Busboom_Garage");
    expect(el.querySelector<HTMLInputElement>('[data-testid="configuration-wifi-password"]')!.value).toBe("hunter2");
    const code = el.querySelector('[data-testid="configuration-code"]')?.textContent ?? "";
    expect(code).toContain("diffDrive.setupRadio(");
    expect(code).toContain('diffDrive.setupWifi("Busboom_Garage", "hunter2")');
  });

  it("Save updates the draft radio address and the code (ticket 006: no longer persisted to localStorage); a bad channel is refused", () => {
    const { el } = mountPage();
    type(el, '[data-testid="configuration-radio-channel"]', "55");
    type(el, '[data-testid="configuration-radio-group"]', "114");
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="configuration-save"]')!.click();
    });
    expect(el.querySelector('[data-testid="configuration-code"]')?.textContent).toContain("diffDrive.setupRadio(55, 114)");
    type(el, '[data-testid="configuration-radio-channel"]', "200");
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="configuration-save"]')!.click();
    });
    expect(el.querySelector('[data-testid="configuration-radio-error"]')?.textContent).toContain("0 to 83");
  });

  it("Save sends set-wifi-credentials, Write to robot sends provision-wifi, and a name with a space is refused", () => {
    const { el, socket } = mountPage();
    act(() => {
      socket.emitMessage({ type: "wifi-credentials", ssid: null, hasPassword: false, source: "none" });
    });
    expect(el.querySelector<HTMLButtonElement>('[data-testid="configuration-write"]')!.disabled).toBe(true);
    type(el, '[data-testid="configuration-wifi-ssid"]', "Busboom Mesh");
    type(el, '[data-testid="configuration-wifi-password"]', "pw");
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="configuration-save"]')!.click();
    });
    expect(el.querySelector('[data-testid="configuration-wifi-error"]')?.textContent).toContain("spaces");

    type(el, '[data-testid="configuration-wifi-ssid"]', "Busboom_Garage");
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="configuration-save"]')!.click();
    });
    expect(sent(socket).slice(-2)).toEqual([
      { type: "set-wifi-credentials", ssid: "Busboom_Garage", password: "pw" },
      { type: "get-wifi-credentials", reveal: true },
    ]);
    act(() => {
      socket.emitMessage({ type: "wifi-credentials", ssid: "Busboom_Garage", hasPassword: true, source: "stored" });
    });
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="configuration-write"]')!.click();
    });
    expect(sent(socket).at(-1)).toEqual({ type: "provision-wifi", linkId: "usb-ROBOT-A", slot: 0 });
  });

  // Ticket 011 (carried from 009's send-gating sweep): both Save and
  // Write to robot gate on `useSendable()`, since Save also sends
  // (`saveWifi`) whenever a Wi-Fi network is stored.
  it("Save and Write to robot both disable once the socket closes, and no message is sent while disabled", () => {
    const { el, socket } = mountPage();
    act(() => {
      socket.emitMessage({ type: "wifi-credentials", ssid: "Busboom_Garage", hasPassword: true, source: "stored", password: "hunter2" });
    });
    expect(el.querySelector<HTMLButtonElement>('[data-testid="configuration-save"]')!.disabled).toBe(false);
    expect(el.querySelector<HTMLButtonElement>('[data-testid="configuration-write"]')!.disabled).toBe(false);

    act(() => {
      socket.close();
    });
    expect(el.querySelector<HTMLButtonElement>('[data-testid="configuration-save"]')!.disabled).toBe(true);
    expect(el.querySelector<HTMLButtonElement>('[data-testid="configuration-write"]')!.disabled).toBe(true);

    const sentBeforeClicks = sent(socket).length;
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="configuration-save"]')!.click();
    });
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="configuration-write"]')!.click();
    });
    expect(sent(socket).length).toBe(sentBeforeClicks);
  });

  it("seeds the radio draft from device.radio and shows its source via the shared AddressSourceChip", () => {
    const device = robot({ radio: { channel: 55, group: 114, source: "override" } });
    const el = mount(
      <WsProvider url="ws://test/" socketFactory={() => new FakeSocket()}>
        <ConfigurationPage device={device} link={device.links[0]!} />
      </WsProvider>,
    );
    expect(el.querySelector<HTMLInputElement>('[data-testid="configuration-radio-channel"]')!.value).toBe("55");
    expect(el.querySelector<HTMLInputElement>('[data-testid="configuration-radio-group"]')!.value).toBe("114");
    const chip = el.querySelector('[data-testid="address-source-chip"]');
    expect(chip?.textContent).toContain("ch 55 / grp 114");
    expect(chip?.textContent).toContain("set for this device");
  });

  it("edits to the calibration values persist to the same per-robot state the Calibration tab uses and show up in the code", () => {
    const { el } = mountPage();
    type(el, "#configuration-wheel-diameter", "91.5");
    expect(JSON.parse(window.localStorage.getItem("robot-console:calibration:tigez") ?? "{}")).toMatchObject({ wheelDiameterMm: 91.5, wheelDiameterSource: "entered" });
    expect(el.querySelector('[data-testid="configuration-code"]')?.textContent).toContain("diffDrive.setWheelCalibration(91.5 * Math.PI / 360)");
  });

  describe("ticket 018-013: the full serial log under the code", () => {
    it("mounts the unfiltered DeviceConsole in the right column, showing every line (not just calibration traffic)", () => {
      const { el, socket } = mountPage();
      act(() => {
        socket.emitMessage({ type: "line", linkId: "usb-ROBOT-A", direction: "rx", line: "status a=1" });
      });
      const right = el.querySelector(".robot-page-column-right")!;
      expect(right.querySelector('[aria-label="Console"]')).not.toBeNull();
      expect(right.querySelector('[data-testid="console-log"]')?.textContent).toContain("status a=1");
    });

    it("ticket 018-018: the right column is viewport-bound (shares RobotPage.css's `robot-page-column-console` with the Main tab), and the 'Code for your program' panel above the console carries the shrink/scroll wrapper class, in document order before the console", () => {
      const { el } = mountPage();
      const right = el.querySelector(".robot-page-column-right")!;
      expect(right.classList.contains("robot-page-column-console")).toBe(true);

      const top = el.querySelector('[aria-label="Configuration code"]')!;
      expect(top.classList.contains("robot-page-column-top")).toBe(true);
      expect(right.contains(top)).toBe(true);

      const consoleEl = el.querySelector('[aria-label="Console"]')!;
      expect(right.contains(consoleEl)).toBe(true);
      // `robot-page-column-top`'s own `max-height` formula (RobotPage.css)
      // reserves room for `.device-console` below it -- this only holds
      // if the panel really does precede the console in the column.
      expect(top.compareDocumentPosition(consoleEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });
});
