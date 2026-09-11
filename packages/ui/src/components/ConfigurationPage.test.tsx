// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
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

function robot(): EndpointListEntry {
  return {
    endpointId: "usb-ROBOT-A",
    transport: "usb",
    resourceKey: "usb-ROBOT-A",
    classification: { type: "robot", role: "NEZHA2", commonName: "robot", dialect: "space", evidence: "role", program: null, version: null },
    name: "tigez",
    role: "NEZHA2",
    sessionOpen: true,
    usb: { serialNumber: "ROBOT-A-FULL", displaySerial: "0004", port: "/dev/cu.usbmodemC" },
  };
}

function mountPage(): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <ConfigurationPage device={robot()} />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket! };
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
      `diffDrive.setupWifi("Busboom_Garage", "${MASKED_PASSWORD}")  // password hidden -- tick 'Show the Wi-Fi password' to fill it in`,
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
  it("asks the host for the network, shows the name-derived radio address, and builds the code block; the password stays masked until revealed", () => {
    const { el, socket } = mountPage();
    expect(sent(socket)).toEqual([{ type: "get-wifi-credentials" }]);
    act(() => {
      socket.emitMessage({ type: "wifi-credentials", ssid: "Busboom_Garage", hasPassword: true, source: "stored" });
    });
    expect(el.querySelector<HTMLInputElement>('[data-testid="configuration-wifi-ssid"]')!.value).toBe("Busboom_Garage");
    let code = el.querySelector('[data-testid="configuration-code"]')?.textContent ?? "";
    expect(code).toContain("diffDrive.setupRadio(");
    expect(code).toContain(`diffDrive.setupWifi("Busboom_Garage", "${MASKED_PASSWORD}")`);
    expect(el.textContent).not.toContain("hunter2");

    act(() => {
      const box = el.querySelector<HTMLInputElement>('[data-testid="configuration-reveal-password"]')!;
      box.click();
    });
    expect(sent(socket).at(-1)).toEqual({ type: "get-wifi-credentials", reveal: true });
    act(() => {
      socket.emitMessage({ type: "wifi-credentials", ssid: "Busboom_Garage", hasPassword: true, source: "stored", password: "hunter2" });
    });
    code = el.querySelector('[data-testid="configuration-code"]')?.textContent ?? "";
    expect(code).toContain('diffDrive.setupWifi("Busboom_Garage", "hunter2")');
  });

  it("saving the radio address writes the console's per-name address and updates the code; a bad channel is refused", () => {
    const { el } = mountPage();
    type(el, '[data-testid="configuration-radio-channel"]', "55");
    type(el, '[data-testid="configuration-radio-group"]', "114");
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="configuration-radio-save"]')!.click();
    });
    expect(JSON.parse(window.localStorage.getItem("robot-console:relay-address:tigez") ?? "{}")).toEqual({ channel: 55, group: 114 });
    expect(el.querySelector('[data-testid="configuration-code"]')?.textContent).toContain("diffDrive.setupRadio(55, 114)");
    type(el, '[data-testid="configuration-radio-channel"]', "200");
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="configuration-radio-save"]')!.click();
    });
    expect(el.querySelector('[data-testid="configuration-radio-error"]')?.textContent).toContain("0 to 83");
  });

  it("saving Wi-Fi sends set-wifi-credentials, Write to robot sends provision-wifi, and a name with a space is refused", () => {
    const { el, socket } = mountPage();
    act(() => {
      socket.emitMessage({ type: "wifi-credentials", ssid: null, hasPassword: false, source: "none" });
    });
    expect(el.querySelector<HTMLButtonElement>('[data-testid="configuration-wifi-write"]')!.disabled).toBe(true);
    type(el, '[data-testid="configuration-wifi-ssid"]', "Busboom Mesh");
    type(el, '[data-testid="configuration-wifi-password"]', "pw");
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="configuration-wifi-save"]')!.click();
    });
    expect(el.querySelector('[data-testid="configuration-wifi-error"]')?.textContent).toContain("spaces");

    type(el, '[data-testid="configuration-wifi-ssid"]', "Busboom_Garage");
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="configuration-wifi-save"]')!.click();
    });
    expect(sent(socket).at(-1)).toEqual({ type: "set-wifi-credentials", ssid: "Busboom_Garage", password: "pw" });
    act(() => {
      socket.emitMessage({ type: "wifi-credentials", ssid: "Busboom_Garage", hasPassword: true, source: "stored" });
    });
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="configuration-wifi-write"]')!.click();
    });
    expect(sent(socket).at(-1)).toEqual({ type: "provision-wifi", endpointId: "usb-ROBOT-A", slot: 0 });
  });

  it("edits to the calibration values persist to the same per-robot state the Calibration tab uses and show up in the code", () => {
    const { el } = mountPage();
    type(el, "#configuration-wheel-diameter", "91.5");
    expect(JSON.parse(window.localStorage.getItem("robot-console:calibration:tigez") ?? "{}")).toMatchObject({ wheelDiameterMm: 91.5, wheelDiameterSource: "entered" });
    expect(el.querySelector('[data-testid="configuration-code"]')?.textContent).toContain("diffDrive.setWheelCalibration(91.5 * Math.PI / 360)");
  });
});
