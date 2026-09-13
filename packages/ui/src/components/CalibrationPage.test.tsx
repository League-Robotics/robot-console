// @vitest-environment jsdom
/**
 * CalibrationPage.test.tsx — the Calibration tab's state machine
 * (OOP 2026-09-10; migrated to the `Snapshot` contract, sprint 015
 * ticket 009; expanded ticket 018-010). The pure calibration-math
 * helpers this page used to re-export (`correctTrackWidth`,
 * `deriveCalibration`, `calibrationCode`) live in, and are tested by,
 * `lib/calibration.test.ts` (ticket 017-008) -- this file keeps only
 * the mounted, FakeSocket-driven behavior.
 *
 * Ticket 018-010 adds: the "Calibration firmware" panel (flash button,
 * USB-only gating, running-program text), run controls derived from
 * `FUNCS` (including a generic control for a `cal*` name neither wizard
 * owns), the FUNCS-on-open request, and `CalibrationTable`'s new
 * robot-reported track-width/slip rows fed from a rotation run.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RobotFunction, SnapshotDevice, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
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

function link(functions: RobotFunction[] | null = [{ name: "calx" }, { name: "cala" }], overrides: Partial<SnapshotLink> = {}): SnapshotLink {
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
    ...overrides,
  };
}

function device(overrides: Partial<SnapshotDevice> = {}): SnapshotDevice {
  return {
    id: 1,
    name: NAME,
    kind: "robot",
    role: "NEZHA2",
    program: null,
    version: null,
    owned: true,
    radio: { channel: 1, group: 1, source: "derived" },
    lastSeen: 0,
    lastChecked: null,
    links: [],
    ...overrides,
  };
}

function mountPage(
  opts: {
    functions?: RobotFunction[] | null;
    linkOverrides?: Partial<SnapshotLink>;
    deviceOverrides?: Partial<SnapshotDevice>;
  } = {},
): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  // `??` would conflate "not provided" (undefined -> use the default
  // fixture) with an explicitly-passed `null` (FUNCS not answered yet,
  // deliberately used by the "requests FUNCS" tests below) -- both are
  // distinct inputs this helper must keep apart.
  const theLink = link(opts.functions !== undefined ? opts.functions : [{ name: "calx" }, { name: "cala" }], opts.linkOverrides);
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <CalibrationPage device={device(opts.deviceOverrides)} link={theLink} name={NAME} />
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

function tx(socket: FakeSocket, line: string): void {
  act(() => {
    socket.emitMessage({ type: "line", linkId: LINK_ID, direction: "tx", line });
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
    expect(el.querySelector('[data-testid="calibration-slip"]')?.textContent).toContain("1.301");
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

  describe("ticket 018-010: Calibration firmware panel", () => {
    it("a plain (non-calibration) robot on a USB link shows what's running and a Flash trigger", () => {
      const { el } = mountPage({ deviceOverrides: { program: null, version: null } });
      const running = el.querySelector('[data-testid="calibration-firmware-not-running"]');
      expect(running?.textContent).toBe("Program: unknown");
      expect(el.querySelector('[data-testid="calibration-firmware-running"]')).toBeNull();
      const flashButton = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Flash calibration firmware");
      expect(flashButton).not.toBeUndefined();
      expect(el.querySelector('[data-testid="calibration-firmware-usb-required"]')).toBeNull();
    });

    it("a robot already running the calibration build says so, and still offers a re-flash trigger", () => {
      const { el } = mountPage({ deviceOverrides: { program: "calibration-0.20260913.1", version: "0.20260913.1" } });
      const running = el.querySelector('[data-testid="calibration-firmware-running"]');
      expect(running?.textContent).toBe("Calibration firmware 0.20260913.1 is running.");
      expect(el.querySelector('[data-testid="calibration-firmware-not-running"]')).toBeNull();
      const flashButton = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Flash calibration firmware");
      expect(flashButton).not.toBeUndefined();
    });

    it("over a non-USB link, says the robot must be plugged in over USB to flash, and offers no Flash trigger", () => {
      const { el } = mountPage({
        linkOverrides: {
          transport: "radio",
          capabilities: { open: false, close: true, flash: false, provisionWifi: false },
        },
      });
      const hint = el.querySelector('[data-testid="calibration-firmware-usb-required"]');
      expect(hint?.textContent).toBe("Plug the robot in over USB to flash the calibration firmware.");
      const flashButton = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Flash calibration firmware");
      expect(flashButton).toBeUndefined();
    });
  });

  describe("ticket 018-010: run controls derived from FUNCS", () => {
    it("requests FUNCS once when the tab opens with no function list yet, and shows a checking hint", () => {
      const { el, socket } = mountPage({ functions: null });
      expect(socket.sent).toEqual([JSON.stringify({ type: "send-command", linkId: LINK_ID, verb: "FUNCS" })]);
      expect(el.querySelector('[data-testid="calibration-functions-checking"]')).not.toBeNull();
      expect(el.querySelector('[data-testid="calibration-no-functions"]')).toBeNull();
    });

    it("does not request FUNCS when a function list is already known", () => {
      const { socket } = mountPage({ functions: [{ name: "calx" }] });
      expect(socket.sent).toEqual([]);
    });

    it("says so plainly when the robot's FUNCS lists no calibration functions, and mounts neither wizard", () => {
      const { el } = mountPage({ functions: [{ name: "line" }, { name: "sense" }] });
      const hint = el.querySelector('[data-testid="calibration-no-functions"]');
      expect(hint?.textContent).toBe("This robot's firmware doesn't report any calibration functions.");
      expect(el.querySelector('.robot-page-column-left [aria-label="Distance calibration"]')).toBeNull();
      expect(el.querySelector('.robot-page-column-left [aria-label="Rotation calibration"]')).toBeNull();
    });

    it("mounts only the wizard for a function FUNCS actually lists", () => {
      const { el } = mountPage({ functions: [{ name: "calx" }] });
      expect(el.querySelector('.robot-page-column-left [aria-label="Distance calibration"]')).not.toBeNull();
      expect(el.querySelector('.robot-page-column-left [aria-label="Rotation calibration"]')).toBeNull();
    });

    it("renders a generic run control for a cal* function neither wizard owns, labelled from its name, and running it sends a bare RUN", () => {
      const { el, socket } = mountPage({ functions: [{ name: "calx" }, { name: "cala" }, { name: "calb" }] });
      const control = el.querySelector('[aria-label="Calibrate b"]');
      expect(control).not.toBeNull();
      const button = el.querySelector<HTMLButtonElement>('[data-testid="calibration-run-calb"]')!;
      expect(button.textContent).toBe("Run");
      expect(button.disabled).toBe(false);

      click(el, '[data-testid="calibration-run-calb"]');
      expect(socket.sent).toContainEqual(JSON.stringify({ type: "send-command", linkId: LINK_ID, verb: "RUN", fields: ["calb"] }));
    });

    it("disables the generic run control's button when the link isn't usable", () => {
      const { el } = mountPage({
        functions: [{ name: "calb" }],
        // Only `state` changes -- `session` (and its `functions`) stays,
        // so the control still renders; `isLinkUsable` requires
        // `state === "connected"`, so it alone is enough to disable it.
        linkOverrides: { state: "failed" },
      });
      const button = el.querySelector<HTMLButtonElement>('[data-testid="calibration-run-calb"]')!;
      expect(button.disabled).toBe(true);
      expect(el.querySelector('[data-testid="calibration-run-calb-hint"]')?.textContent).toBe(
        "Open a link to this robot to run calb.",
      );
    });
  });

  describe("ticket 018-010: robot-reported track width and slip in the Current calibration table", () => {
    it("a successful rotation run fills the robot-reported track width and slip rows alongside the derived values", () => {
      const { el, socket } = mountPage();
      type(el, "calibration-wheel-diameter", "90.28");
      click(el, '[data-testid="rotation-calibration-go"]');
      rx(socket, "CALA:measured b=8.84cm  (anchor was 12.08)");
      rx(socket, "CALA:derived slip=1.301 = track 11.5 / b 8.84");
      rx(socket, "CALA:apply diffDrive.setConfigValue(ConfigField.RotationalSlip, 1.301)");

      expect(el.querySelector('[data-testid="calibration-reported-track-width"]')?.textContent).toContain("8.84 cm");
      expect(el.querySelector('[data-testid="calibration-reported-track-width"]')?.textContent).toContain(
        "robot-reported, from rotation calibration",
      );
      expect(el.querySelector('[data-testid="calibration-robot-reported-slip"]')?.textContent).toContain("1.301");
    });

    it("a failed re-verification clears the robot-reported slip too", () => {
      const { el, socket } = mountPage();
      type(el, "calibration-wheel-diameter", "90.28");
      click(el, '[data-testid="rotation-calibration-go"]');
      rx(socket, "CALA:measured b=8.84cm  (anchor was 12.08)");
      rx(socket, "CALA:derived slip=1.301 = track 11.5 / b 8.84");
      rx(socket, "CALA:apply diffDrive.setConfigValue(ConfigField.RotationalSlip, 1.301)");
      expect(el.querySelector('[data-testid="calibration-robot-reported-slip"]')).not.toBeNull();

      rx(socket, "CALA:fail gap 148deg before 270 -- missed an arm, re-centre the robot");
      expect(el.querySelector('[data-testid="calibration-robot-reported-slip"]')).toBeNull();
      expect(el.querySelector('[data-testid="calibration-reported-track-width"]')?.textContent).toContain("not measured yet");
    });
  });

  describe("ticket 018-010: CalibrationConsole (the filtered console below the code block)", () => {
    it("shows CAL*: report lines and hides unrelated console-only traffic", () => {
      const { el, socket } = mountPage();
      rx(socket, "CALX:diameter=90.68 mm");
      rx(socket, "status a=1");
      rx(socket, "get name value");

      const lines = Array.from(el.querySelectorAll('[data-testid="calibration-console-line"]')).map((n) => n.textContent);
      expect(lines).toEqual(["«CALX:diameter=90.68 mm"]);
    });

    it("shows the RUN tx line for a cal* function and its immediately-following ack/err reply, but not an unrelated ack", () => {
      const { el, socket } = mountPage({ functions: [{ name: "calb" }] });
      tx(socket, "run calb #3");
      rx(socket, "ack 3 1 none");
      tx(socket, "get name #4");
      rx(socket, "ack 4 1 none");

      const lines = Array.from(el.querySelectorAll('[data-testid="calibration-console-line"]')).map((n) => n.textContent);
      expect(lines).toEqual(["»run calb #3", "«ack 3 1 none"]);
    });

    it("Clear empties the calibration console without touching the full DeviceConsole's own log for the same link", () => {
      const { el, socket } = mountPage();
      rx(socket, "CALX:diameter=90.68 mm");
      expect(el.querySelectorAll('[data-testid="calibration-console-line"]').length).toBe(1);

      click(el, '[data-testid="calibration-console-clear"]');
      expect(el.querySelectorAll('[data-testid="calibration-console-line"]').length).toBe(0);
      // The full, unfiltered console (right column) still has the line --
      // Clear here must not call the shared `clearLinkLog`.
      expect(el.querySelectorAll('[data-testid="console-line-rx"]').length).toBe(1);

      rx(socket, "CALX:apply diffDrive.setWheelCalibration(0.7912)");
      expect(el.querySelectorAll('[data-testid="calibration-console-line"]').length).toBe(1);
    });
  });
});
