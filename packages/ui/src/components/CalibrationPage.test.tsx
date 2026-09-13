// @vitest-environment jsdom
/**
 * CalibrationPage.test.tsx — the Calibration tab's state machine
 * (OOP 2026-09-10; migrated to the `Snapshot` contract, sprint 015
 * ticket 009): wheel diameter gates the rotation run, the two wizards
 * feed one calibration state, and one code block is built from it. The
 * pure calibration-math helpers this page used to re-export
 * (`correctTrackWidth`, `deriveCalibration`, `calibrationCode`) now live
 * in, and are tested by, `lib/calibration.test.ts` (ticket 017-008) --
 * this file keeps only the mounted, FakeSocket-driven behavior.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RobotFunction, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { CalibrationPage } from "./CalibrationPage";
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

const LINK_ID = "usb-ROBOT-A";
const NAME = "gopiv";

function link(functions: RobotFunction[] = [{ name: "calx" }, { name: "cala" }]): SnapshotLink {
  return {
    id: LINK_ID,
    transport: "usb",
    label: "USB · /dev/cu.usbmodemC",
    state: "connected",
    reason: null,
    since: 0,
    lastSeen: 0,
    nextRetryAt: null,
    capabilities: { open: false, close: true, flash: true, provisionWifi: true },
    session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions },
  };
}

function mountPage(): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <CalibrationPage link={link()} name={NAME} />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket! };
}

function rx(socket: FakeSocket, line: string): void {
  act(() => {
    socket.emitMessage({ type: "line", linkId: LINK_ID, direction: "rx", line });
  });
}

function click(el: HTMLDivElement, selector: string): void {
  act(() => {
    el.querySelector<HTMLButtonElement>(selector)!.click();
  });
}

function type(el: HTMLDivElement, id: string, value: string): void {
  const input = el.querySelector<HTMLInputElement>(`#${id}`)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("CalibrationPage", () => {
  it("starts empty: no code, rotation blocked, and a distance run unlocks rotation and fills the code block", () => {
    const { el, socket } = mountPage();
    expect(el.querySelector('[data-testid="calibration-code-empty"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-blocked"]')).not.toBeNull();
    expect(el.querySelector<HTMLButtonElement>('[data-testid="rotation-calibration-go"]')!.disabled).toBe(true);

    click(el, '[data-testid="distance-calibration-go"]');
    rx(socket, "CALX:begin true=90cm baseline=0.7878mm/deg");
    rx(socket, "CALX:calib=0.7912 mm/deg  (was 0.7878)");
    rx(socket, "CALX:diameter=90.68 mm");
    rx(socket, "CALX:apply diffDrive.setWheelCalibration(0.7912)");

    expect(el.querySelector<HTMLInputElement>("#calibration-wheel-diameter")!.value).toBe("90.68");
    expect(el.querySelector('[data-testid="calibration-code"]')?.textContent).toContain(
      "diffDrive.setWheelCalibration(90.68 * Math.PI / 360)",
    );
    expect(el.querySelector('[data-testid="rotation-calibration-blocked"]')).toBeNull();
    expect(el.querySelector<HTMLButtonElement>('[data-testid="rotation-calibration-go"]')!.disabled).toBe(false);
  });

  it("a rotation run without a measured track width sets the effective width as the track width with slip 1; typing a measured width switches to a computed slip", () => {
    const { el, socket } = mountPage();
    type(el, "calibration-wheel-diameter", "90.28");
    click(el, '[data-testid="rotation-calibration-go"]');
    rx(socket, "CALA:begin track=11.5cm slip=0.952 b=12.08cm");
    rx(socket, "CALA:pass clockwise");
    rx(socket, "CALA:measured b=8.84cm  (anchor was 12.08)");
    rx(socket, "CALA:derived slip=1.301 = track 11.5 / b 8.84");
    rx(socket, "CALA:apply diffDrive.setConfigValue(ConfigField.RotationalSlip, 1.301)");

    expect(el.querySelector('[data-testid="calibration-effective-track"]')?.textContent).toBe("8.84 cm");
    let code = el.querySelector('[data-testid="calibration-code"]')?.textContent ?? "";
    expect(code).toContain("diffDrive.setTrackWidth(8.84)");
    expect(code).toContain("ConfigField.RotationalSlip, 1)");

    type(el, "calibration-track-width", "11.5");
    code = el.querySelector('[data-testid="calibration-code"]')?.textContent ?? "";
    expect(code).toContain("diffDrive.setTrackWidth(11.5)");
    expect(code).toContain("ConfigField.RotationalSlip, 1.301)");
    expect(el.querySelector('[data-testid="calibration-slip"]')?.textContent).toBe("1.301");
  });

  it("a failed re-verification drops the rotation result again", () => {
    const { el, socket } = mountPage();
    type(el, "calibration-wheel-diameter", "90.28");
    click(el, '[data-testid="rotation-calibration-go"]');
    rx(socket, "CALA:measured b=8.84cm  (anchor was 12.08)");
    rx(socket, "CALA:apply diffDrive.setConfigValue(ConfigField.RotationalSlip, 1.301)");
    expect(el.querySelector('[data-testid="calibration-effective-track"]')?.textContent).toBe("8.84 cm");
    rx(socket, "CALA:fail gap 148deg before 270 -- missed an arm, re-centre the robot");
    expect(el.querySelector('[data-testid="calibration-effective-track"]')?.textContent).toContain("not measured yet");
    expect(el.querySelector('[data-testid="calibration-code"]')?.textContent).not.toContain("setTrackWidth");
  });

  it("persists per robot name and Start over clears it", () => {
    const first = mountPage();
    type(first.el, "calibration-wheel-diameter", "91");
    act(() => {
      root!.unmount();
    });
    root = null;
    container?.remove();
    container = null;

    const second = mountPage();
    expect(second.el.querySelector<HTMLInputElement>("#calibration-wheel-diameter")!.value).toBe("91");
    click(second.el, '[data-testid="calibration-reset"]');
    expect(second.el.querySelector<HTMLInputElement>("#calibration-wheel-diameter")!.value).toBe("");
    expect(second.el.querySelector('[data-testid="calibration-code-empty"]')).not.toBeNull();
  });
});
