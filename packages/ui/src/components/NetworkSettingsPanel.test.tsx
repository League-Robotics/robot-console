// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SnapshotDevice, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { NetworkSettingsPanel } from "./NetworkSettingsPanel";
import type { CalibrationWrite } from "../lib/calibrationWrite";
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

const LINK: SnapshotLink = {
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
};

const DEVICE: SnapshotDevice = {
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
  links: [LINK],
};

function mountPanel(calibrationWrites: CalibrationWrite[] = []) {
  let socket: FakeSocket | null = null;
  const onRadioChange = vi.fn();
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <NetworkSettingsPanel
        device={DEVICE}
        link={LINK}
        radio={{ channel: 41, group: 3 }}
        onRadioChange={onRadioChange}
        calibrationWrites={calibrationWrites}
      />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket!, onRadioChange };
}

function type(el: HTMLDivElement, selector: string, value: string): void {
  const input = el.querySelector<HTMLInputElement>(selector)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(el: HTMLDivElement, testId: string): void {
  act(() => {
    el.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click();
  });
}

function sent(socket: FakeSocket): unknown[] {
  return socket.sent.map((raw) => JSON.parse(raw));
}

describe("NetworkSettingsPanel", () => {
  it("puts the network name and password on one row, and the channel and group on another", () => {
    const { el } = mountPanel();
    const wifiRows = el.querySelectorAll('[data-testid="configuration-wifi"] tr');
    expect(wifiRows).toHaveLength(1);
    expect(wifiRows[0]!.querySelectorAll("input")).toHaveLength(2);
    const radioRows = el.querySelectorAll('[data-testid="configuration-radio"] tr');
    expect(radioRows).toHaveLength(1);
    expect(radioRows[0]!.querySelectorAll("input")).toHaveLength(2);
  });

  it("shows the saved network once wifi-credentials arrives, and the robot's radio address", () => {
    const { el, socket } = mountPanel();
    act(() => {
      socket.emitMessage({ type: "wifi-credentials", ssid: "Busboom_Garage", hasPassword: true, source: "stored", password: "hunter2" });
    });
    expect(el.querySelector<HTMLInputElement>('[data-testid="configuration-wifi-ssid"]')!.value).toBe("Busboom_Garage");
    expect(el.querySelector<HTMLInputElement>('[data-testid="configuration-wifi-password"]')!.value).toBe("hunter2");
    expect(el.querySelector<HTMLInputElement>('[data-testid="configuration-radio-channel"]')!.value).toBe("41");
    expect(el.querySelector<HTMLInputElement>('[data-testid="configuration-radio-group"]')!.value).toBe("3");
  });

  it("reports the radio address as it is typed, and never a bad one", () => {
    const { el, onRadioChange } = mountPanel();
    type(el, '[data-testid="configuration-radio-channel"]', "55");
    expect(onRadioChange).toHaveBeenLastCalledWith({ channel: 55, group: 3 });
    type(el, '[data-testid="configuration-radio-group"]', "114");
    expect(onRadioChange).toHaveBeenLastCalledWith({ channel: 55, group: 114 });

    type(el, '[data-testid="configuration-radio-channel"]', "200");
    expect(onRadioChange).toHaveBeenCalledTimes(2);
    click(el, "configuration-save");
    expect(el.querySelector('[data-testid="configuration-radio-error"]')?.textContent).toContain("0 to 83");
  });

  it("reports the Wi-Fi boxes as they are typed", () => {
    let socket: FakeSocket | null = null;
    const onWifiChange = vi.fn();
    const el = mount(
      <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
        <NetworkSettingsPanel
          device={DEVICE}
          link={LINK}
          radio={{ channel: 41, group: 3 }}
          onRadioChange={() => {}}
          onWifiChange={onWifiChange}
          calibrationWrites={[]}
        />
      </WsProvider>,
    );
    act(() => {
      socket!.emitOpen();
    });
    type(el, '[data-testid="configuration-wifi-ssid"]', "Garage");
    type(el, '[data-testid="configuration-wifi-password"]', "pw");
    expect(onWifiChange).toHaveBeenLastCalledWith({ ssid: "Garage", password: "pw" });
  });

  it("Save sends set-wifi-credentials, and Write to robot sends provision-wifi", () => {
    const { el, socket } = mountPanel();
    act(() => {
      socket.emitMessage({ type: "wifi-credentials", ssid: null, hasPassword: false, source: "none" });
    });
    expect(el.querySelector<HTMLButtonElement>('[data-testid="configuration-write"]')!.disabled).toBe(true);
    type(el, '[data-testid="configuration-wifi-ssid"]', "Busboom_Garage");
    type(el, '[data-testid="configuration-wifi-password"]', "pw");
    click(el, "configuration-save");
    expect(sent(socket).slice(-2)).toEqual([
      { type: "set-wifi-credentials", ssid: "Busboom_Garage", password: "pw" },
      { type: "get-wifi-credentials", reveal: true },
    ]);
    act(() => {
      socket.emitMessage({ type: "wifi-credentials", ssid: "Busboom_Garage", hasPassword: true, source: "stored" });
    });
    click(el, "configuration-write");
    expect(sent(socket).at(-1)).toEqual({ type: "provision-wifi", linkId: "usb-ROBOT-A", slot: 0 });
  });

  it("Write to robot also sends the calibration values it is given", () => {
    const { el, socket } = mountPanel([{ key: "wheelDiameter", name: "wheel_diameter", value: 81.45, unit: "mm" }]);
    click(el, "configuration-write");
    expect(sent(socket).slice(-2)).toEqual([
      { type: "send-command", linkId: "usb-ROBOT-A", verb: "SET", fields: ["wheel_diameter", "81.45"] },
      { type: "send-command", linkId: "usb-ROBOT-A", verb: "RUN", fields: ["calsave", "81.45", "0", "0"] },
    ]);
    expect(el.querySelector('[data-testid="configuration-calibration-written"]')?.textContent).toContain("wheel_diameter 81.45 mm");
  });

  it("disables Save and Write to robot once the socket closes", () => {
    const { el, socket } = mountPanel();
    act(() => {
      socket.emitMessage({ type: "wifi-credentials", ssid: "Busboom_Garage", hasPassword: true, source: "stored", password: "hunter2" });
    });
    expect(el.querySelector<HTMLButtonElement>('[data-testid="configuration-save"]')!.disabled).toBe(false);
    act(() => {
      socket.close();
    });
    expect(el.querySelector<HTMLButtonElement>('[data-testid="configuration-save"]')!.disabled).toBe(true);
    expect(el.querySelector<HTMLButtonElement>('[data-testid="configuration-write"]')!.disabled).toBe(true);
  });
  it("shows the address the robot's name derives, and asks the robot for its own once the link is open", () => {
    const { el, socket } = mountPanel();
    expect(el.querySelector<HTMLInputElement>('[data-testid="configuration-wifi-address"]')!.value).toBe("10.55.179.52");
    expect(sent(socket)).toContainEqual({ type: "send-command", linkId: "usb-ROBOT-A", verb: "RUN", fields: ["netshow"] });

    act(() => {
      socket.emitMessage({
        type: "line",
        linkId: "usb-ROBOT-A",
        direction: "rx",
        line: '{"ev":"netstore.values","ip":"10.55.1.77","stored":1,"default":"10.55.179.52"}',
      });
    });
    expect(el.querySelector<HTMLInputElement>('[data-testid="configuration-wifi-address"]')!.value).toBe("10.55.1.77");
    expect(el.querySelector('[data-testid="configuration-wifi-address-note"]')!.textContent).toContain("stored on the robot");
  });

  it("writes an edited address to the robot, and clears the stored one when it is set back to the default", () => {
    const { el, socket } = mountPanel();
    type(el, '[data-testid="configuration-wifi-address"]', "10.55.1.77");
    click(el, "configuration-write");
    expect(sent(socket).at(-1)).toEqual({
      type: "send-command",
      linkId: "usb-ROBOT-A",
      verb: "RUN",
      fields: ["netset", "10", "55", "1", "77"],
    });

    type(el, '[data-testid="configuration-wifi-address"]', "10.55.179.52");
    click(el, "configuration-write");
    expect(sent(socket).at(-1)).toEqual({ type: "send-command", linkId: "usb-ROBOT-A", verb: "RUN", fields: ["netclear"] });
  });

  it("refuses to write an address that is not one, and says why", () => {
    const { el, socket } = mountPanel();
    type(el, '[data-testid="configuration-wifi-address"]', "10.55.300.1");
    expect(el.querySelector('[data-testid="configuration-wifi-address-error"]')).not.toBeNull();
    expect(el.querySelector<HTMLButtonElement>('[data-testid="configuration-write"]')!.disabled).toBe(true);
    expect(sent(socket).some((message) => JSON.stringify(message).includes("netset"))).toBe(false);
  });

  it("Restart robot sends the reboot command", () => {
    const { el, socket } = mountPanel();
    click(el, "configuration-restart");
    expect(sent(socket).at(-1)).toEqual({ type: "send-command", linkId: "usb-ROBOT-A", verb: "RUN", fields: ["reboot"] });
  });
});
