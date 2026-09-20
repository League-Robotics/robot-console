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
 *
 * Ticket 022-001 moved this page's own `configurationCode`/
 * `MASKED_PASSWORD`/`jsString` out to `lib/programCode.ts` (renamed
 * `programCode`) -- its own unit tests moved with it, to
 * `lib/programCode.test.ts`. This file keeps only the mounted,
 * FakeSocket-driven `ConfigurationPage` behavior.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SnapshotDevice, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { ConfigurationPage } from "./ConfigurationPage";
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

describe("ConfigurationPage", () => {
  // Ticket 022-001: the `get-wifi-credentials` request itself moved up
  // to `RobotPage.tsx` (so the Calibration tab sees it too -- see that
  // file's own doc comment and `RobotPage.test.tsx`'s own coverage of
  // the request); this page, mounted standalone here with no
  // `RobotPage` above it, no longer sends it itself. It still reacts
  // correctly once a `wifi-credentials` reply arrives from *any*
  // sender, which is all this test now needs to emit by hand.
  it("shows a revealed network in the fields and puts it in the code once wifi-credentials arrives", () => {
    const { el, socket } = mountPage();
    expect(sent(socket)).toEqual([]);
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

  // 2026-09-19: calibration became writable over the wire
  // (`wheel_diameter` 40, `track_width` 41, alongside the existing
  // `rotational_slip` 16). These three cover the whole point of that
  // change -- a value typed on this page reaching the robot -- and in
  // particular the cm->mm conversion, which nothing in the protocol
  // would catch if it regressed.
  it("Write to robot sends the entered calibration as SETs, track width converted to mm", () => {
    const { el, socket } = mountPage();
    act(() => {
      socket.emitMessage({ type: "wifi-credentials", ssid: null, hasPassword: false, source: "none" });
    });
    // Nothing entered and no Wi-Fi stored: nothing to write.
    expect(el.querySelector<HTMLButtonElement>('[data-testid="configuration-write"]')!.disabled).toBe(true);

    type(el, "#configuration-wheel-diameter", "81.45");
    type(el, "#configuration-track-width", "12.85");
    expect(el.querySelector<HTMLButtonElement>('[data-testid="configuration-write"]')!.disabled).toBe(false);

    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="configuration-write"]')!.click();
    });
    // 12.85 cm leaves as 128.5 mm. A 12.85 on the wire would be a
    // 1.3 cm robot and a turn a tenth of the size it was asked for.
    expect(sent(socket).slice(-3)).toEqual([
      { type: "send-command", linkId: "usb-ROBOT-A", verb: "SET", fields: ["wheel_diameter", "81.45"] },
      { type: "send-command", linkId: "usb-ROBOT-A", verb: "SET", fields: ["track_width", "128.5"] },
      // ...and the store verb, so it survives the power cycle. cm here,
      // mm above: calsave is a program on the robot calling
      // setTrackWidth(), whose unit is centimetres.
      { type: "send-command", linkId: "usb-ROBOT-A", verb: "RUN", fields: ["calsave", "81.45", "12.85", "0"] },
    ]);
    expect(el.querySelector('[data-testid="configuration-calibration-written"]')?.textContent).toContain(
      "track_width 128.5 mm",
    );
  });

  it("Write to robot still provisions Wi-Fi, and sends both when both are filled in", () => {
    const { el, socket } = mountPage();
    act(() => {
      socket.emitMessage({ type: "wifi-credentials", ssid: "Busboom_Garage", hasPassword: true, source: "stored" });
    });
    type(el, "#configuration-wheel-diameter", "81.45");
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="configuration-write"]')!.click();
    });
    expect(sent(socket).slice(-3)).toEqual([
      { type: "provision-wifi", linkId: "usb-ROBOT-A", slot: 0 },
      { type: "send-command", linkId: "usb-ROBOT-A", verb: "SET", fields: ["wheel_diameter", "81.45"] },
      { type: "send-command", linkId: "usb-ROBOT-A", verb: "RUN", fields: ["calsave", "81.45", "0", "0"] },
    ]);
  });

  it("sends no calibration SET for a value this session does not have", () => {
    const { el, socket } = mountPage();
    act(() => {
      socket.emitMessage({ type: "wifi-credentials", ssid: "Busboom_Garage", hasPassword: true, source: "stored" });
    });
    const before = sent(socket).length;
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="configuration-write"]')!.click();
    });
    // Wi-Fi only: no calibration entered, so no SETs and no claim of one.
    expect(sent(socket).slice(before)).toEqual([
      { type: "provision-wifi", linkId: "usb-ROBOT-A", slot: 0 },
    ]);
    expect(el.querySelector('[data-testid="configuration-calibration-written"]')).toBeNull();
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
