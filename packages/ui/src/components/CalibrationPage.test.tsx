// @vitest-environment jsdom
/**
 * CalibrationPage.test.tsx — the Calibration tab's state machine
 * (OOP 2026-09-10; migrated to the `Snapshot` contract, sprint 015
 * ticket 009; expanded ticket 018-013; corrected 018-013, stakeholder
 * 2026-09-13). The pure calibration-math helpers this page used to
 * re-export (`correctTrackWidth`, `deriveCalibration`, `calibrationCode`)
 * live in, and are tested by, `lib/calibration.test.ts` (ticket 017-008)
 * -- this file keeps only the mounted, FakeSocket-driven behavior.
 *
 * Ticket 018-013 adds: run controls derived from `FUNCS` (including a
 * generic control for a `cal*` name neither wizard owns), the
 * FUNCS-on-open request, and `CalibrationTable`'s new robot-reported
 * track-width/slip rows fed from a rotation run.
 *
 * Corrected 018-013 (stakeholder, 2026-09-13, "put it under Calibrate"):
 * the "Calibration firmware" panel (flash button, USB-only gating,
 * running-program text) -- which a same-day earlier pass had moved to
 * `ConfigurationPage.test.tsx` -- moves back here, so this page takes a
 * `device` prop again. The FUNCS-derived wizard gating (`showDistance
 * Wizard`/`showRotationWizard`/`noCalFunctions`) is removed outright:
 * both wizards always render now (see this page's own doc comment for
 * the root-cause bug this fixes), so those tests are replaced with ones
 * asserting the wizards render regardless and each shows its own
 * non-blocking hint. The filtered `CalibrationConsole` panel is retired
 * (see this page's own doc comment); its describe block is deleted.
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

function device(theLink: SnapshotLink, overrides: Partial<Omit<SnapshotDevice, "links">> = {}): SnapshotDevice {
  return {
    id: 1,
    name: NAME,
    kind: "robot",
    role: "NEZHA2",
    commonName: null,
    program: null,
    version: null,
    owned: true,
    radio: { channel: 1, group: 1, source: "derived" },
    lastSeen: 0,
    lastChecked: null,
    links: [theLink],
    ...overrides,
  };
}

function mountPage(
  opts: {
    functions?: RobotFunction[] | null;
    linkOverrides?: Partial<SnapshotLink>;
    deviceOverrides?: Partial<Omit<SnapshotDevice, "links">>;
  } = {},
): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  // `??` would conflate "not provided" (undefined -> use the default
  // fixture) with an explicitly-passed `null` (FUNCS not answered yet,
  // deliberately used by the "requests FUNCS" tests below) -- both are
  // distinct inputs this helper must keep apart.
  const theLink = link(opts.functions !== undefined ? opts.functions : [{ name: "calx" }, { name: "cala" }], opts.linkOverrides);
  const theDevice = device(theLink, opts.deviceOverrides);
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <CalibrationPage link={theLink} name={NAME} device={theDevice} />
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

  describe("ticket 018-013: run controls derived from FUNCS (corrected 2026-09-13: FUNCS only ever adds a control, never hides one)", () => {
    it("requests FUNCS once when the tab opens with no function list yet", () => {
      const { socket } = mountPage({ functions: null });
      expect(socket.sent).toEqual([JSON.stringify({ type: "send-command", linkId: LINK_ID, verb: "FUNCS" })]);
    });

    it("does not request FUNCS when a function list is already known", () => {
      const { socket } = mountPage({ functions: [{ name: "calx" }] });
      expect(socket.sent).toEqual([]);
    });

    it("stakeholder correction 2026-09-13: both wizards still render, Calibrate A included, even when FUNCS lists only calx -- the root-caused Wi-Fi burst-drop bug means an absent name proves nothing", () => {
      const { el } = mountPage({ functions: [{ name: "calx" }] });
      expect(el.querySelector('.robot-page-column-left [aria-label="Distance calibration"]')).not.toBeNull();
      expect(el.querySelector('.robot-page-column-left [aria-label="Rotation calibration"]')).not.toBeNull();
      // Calibrate A is still blocked pending a wheel diameter (an
      // unrelated, legitimate gate this page itself applies) -- typing
      // one clears that gate, leaving only the FUNCS-derived hint below,
      // never a disabled button caused by the missing `cala` listing.
      type(el, "calibration-wheel-diameter", "90.28");
      expect(el.querySelector<HTMLButtonElement>('[data-testid="rotation-calibration-go"]')!.disabled).toBe(false);
      expect(el.querySelector('[data-testid="rotation-calibration-unavailable"]')?.textContent).toContain(
        "didn't include cala",
      );
    });

    it("both wizards still render, with their own hints, even when FUNCS lists no calibration functions at all", () => {
      const { el } = mountPage({ functions: [{ name: "line" }, { name: "sense" }] });
      expect(el.querySelector('.robot-page-column-left [aria-label="Distance calibration"]')).not.toBeNull();
      expect(el.querySelector('.robot-page-column-left [aria-label="Rotation calibration"]')).not.toBeNull();
      expect(el.querySelector<HTMLButtonElement>('[data-testid="distance-calibration-go"]')!.disabled).toBe(false);
      // Rotation is blocked pending a wheel diameter until the distance
      // wizard succeeds -- unrelated to FUNCS -- but shows its own hint.
      expect(el.querySelector('[data-testid="rotation-calibration-blocked"]')).not.toBeNull();
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

  describe("ticket 018-013: robot-reported track width and slip in the Current calibration table", () => {
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

  describe("ticket 018-013, corrected 2026-09-13: Calibration firmware flash/verify block (moved here from the Configuration tab)", () => {
    it("shows the current program and a Flash trigger for a USB-flashable link", () => {
      const { el } = mountPage({ deviceOverrides: { program: null, version: null } });
      expect(el.querySelector('[data-testid="calibration-firmware-not-running"]')?.textContent).toBe("Program: unknown");
      expect(el.querySelector('[data-testid="calibration-flash-firmware"]')).not.toBeNull();
      expect(el.querySelector('[data-testid="calibration-firmware-usb-required"]')).toBeNull();
    });

    it("says the running calibration build's version when the current program is one", () => {
      const { el } = mountPage({ deviceOverrides: { program: "calibration-0.20260913.1", version: "0.20260913.1" } });
      expect(el.querySelector('[data-testid="calibration-firmware-running"]')?.textContent).toBe(
        "Calibration firmware 0.20260913.1 is running.",
      );
    });

    it("over a non-flashable link with no other flashable link on the device, says to plug in over USB or use a farm host, and shows no Flash trigger", () => {
      const { el } = mountPage({
        linkOverrides: { transport: "radio", capabilities: { open: false, close: true, flash: false, provisionWifi: false } },
      });
      expect(el.querySelector('[data-testid="calibration-firmware-usb-required"]')?.textContent).toBe(
        "Plug the robot in over USB, or put it on a farm host, to flash.",
      );
      expect(el.querySelector('[data-testid="calibration-flash-firmware"]')).toBeNull();
    });

    it("clicking Flash sends flash-start for the robot release firmware on the flashable link, once firmware is configured/available", () => {
      const { el, socket } = mountPage();
      act(() => {
        socket.emitMessage({
          type: "snapshot",
          seq: 1,
          at: 0,
          devices: [],
          unassigned: [],
          relays: [],
          firmware: { relay: { configured: false }, robot: { configured: true, repoUrl: "https://x", tag: "latest", available: true } },
          wifi: { ssid: null, source: null },
          tasks: [],
        });
      });
      act(() => {
        el.querySelector<HTMLButtonElement>('[data-testid="calibration-flash-firmware"]')!.click();
      });
      expect(socket.sent).toContainEqual(
        JSON.stringify({ type: "flash-start", linkId: LINK_ID, source: { kind: "release", firmware: "robot" } }),
      );
    });

    it("shows inline phase progress while a flash is in flight, then the confirmed outcome once the fresh program is a calibration build", () => {
      const { el, socket } = mountPage({ deviceOverrides: { program: "calibration-0.20260913.1", version: "0.20260913.1" } });
      act(() => {
        socket.emitMessage({ type: "flash-progress", linkId: LINK_ID, source: { kind: "release", firmware: "robot" }, phase: "writing", seq: 1 });
      });
      expect(el.querySelector('[data-testid="calibration-flash-progress"]')?.textContent).toContain("writing");
      expect(el.querySelector('[data-testid="calibration-flash-firmware"]')).toBeNull();

      act(() => {
        socket.emitMessage({ type: "flash-result", linkId: LINK_ID, source: { kind: "release", firmware: "robot" }, status: "ok", seq: 2 });
      });
      expect(el.querySelector('[data-testid="calibration-flash-result"]')?.textContent).toBe(
        "Calibration firmware 0.20260913.1 confirmed.",
      );
    });

    it("reports the actual (non-calibration) program when a flash succeeds but the fresh snapshot isn't a calibration build -- never assumes success", () => {
      const { el, socket } = mountPage({ deviceOverrides: { program: "some-other-build", version: "9" } });
      act(() => {
        socket.emitMessage({ type: "flash-result", linkId: LINK_ID, source: { kind: "release", firmware: "robot" }, status: "ok", seq: 1 });
      });
      expect(el.querySelector('[data-testid="calibration-flash-result"]')?.textContent).toBe(
        "Flashed, but the robot reports program some-other-build — not the calibration build.",
      );
    });

    it("surfaces a flash-result error's message instead of any confirmation text", () => {
      const { el, socket } = mountPage();
      act(() => {
        socket.emitMessage({
          type: "flash-result",
          linkId: LINK_ID,
          source: { kind: "release", firmware: "robot" },
          status: "error",
          message: "sha256 mismatch on downloaded hex",
          seq: 1,
        });
      });
      expect(el.querySelector('[data-testid="calibration-flash-result"]')?.textContent).toBe("sha256 mismatch on downloaded hex");
    });
  });
});
