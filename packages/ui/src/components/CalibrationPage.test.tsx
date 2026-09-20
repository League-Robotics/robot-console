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

function link(functions: RobotFunction[] | null = [{ name: "calwheels" }, { name: "calturn" }], overrides: Partial<SnapshotLink> = {}): SnapshotLink {
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
  const theLink = link(opts.functions !== undefined ? opts.functions : [{ name: "calwheels" }, { name: "calturn" }], opts.linkOverrides);
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
  /** A succeeded `calwheels` run, as the firmware emits it. */
  const WHEELS =
    '{"ev":"calwheels.result","calib":0.7912,"diameter":90.68,"measured":89.61,"true":90,"error":-0.39,"was":0.7878}';

  it("starts with nothing but Start: no code, no run buttons until the flow begins", () => {
    const { el } = mountPage();
    expect(el.querySelector('[data-testid="calibration-code-empty"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="new-calibration-start"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="new-calibration-wheels"]')).toBeNull();
    expect(el.querySelector('[data-testid="new-calibration-turns"]')).toBeNull();
    expect(el.querySelector('[data-testid="new-calibration-done"]')).toBeNull();
  });

  it("Start -> wheels -> turns -> Done, each step appearing only once the one before it has run", () => {
    const { el, socket } = mountPage();
    click(el, '[data-testid="new-calibration-start"]');
    // Wheels is offered; turns and Done are not, because a turn
    // measured against no wheel means nothing.
    expect(el.querySelector('[data-testid="new-calibration-wheels"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="new-calibration-turns"]')).toBeNull();

    click(el, '[data-testid="new-calibration-wheels"]');
    rx(socket, WHEELS);
    expect(el.querySelector<HTMLInputElement>("#calibration-wheel-diameter")!.value).toBe("90.68");
    expect(el.querySelector('[data-testid="new-calibration-turns"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="new-calibration-done"]')).toBeNull();

    click(el, '[data-testid="new-calibration-turns"]');
    rx(socket, '{"ev":"calturn.result","b":8.84,"tw":11.5,"slip":1.301}');
    expect(el.querySelector('[data-testid="calibration-effective-track"]')?.textContent).toContain("8.84 cm");
    expect(el.querySelector('[data-testid="new-calibration-done"]')).not.toBeNull();
  });

  it("re-running wheels invalidates the turn: Done disappears until turns is run again", () => {
    // A turn is denominated in the wheel that was on the robot when it
    // spun. Pairing a fresh diameter with the previous slip is the
    // silent wrong answer this gate exists to prevent.
    const { el, socket } = mountPage();
    click(el, '[data-testid="new-calibration-start"]');
    click(el, '[data-testid="new-calibration-wheels"]');
    rx(socket, WHEELS);
    click(el, '[data-testid="new-calibration-turns"]');
    rx(socket, '{"ev":"calturn.result","b":8.84,"tw":11.5,"slip":1.301}');
    expect(el.querySelector('[data-testid="new-calibration-done"]')).not.toBeNull();

    click(el, '[data-testid="new-calibration-wheels"]');
    rx(socket, '{"ev":"calwheels.result","calib":0.7101,"diameter":81.37,"measured":100.3,"true":90.5,"error":9.8,"was":0.7878}');
    expect(el.querySelector('[data-testid="new-calibration-done"]')).toBeNull();
    expect(el.querySelector('[data-testid="calibration-effective-track"]')?.textContent).toContain("not measured yet");

    click(el, '[data-testid="new-calibration-turns"]');
    rx(socket, '{"ev":"calturn.result","b":12.9,"tw":11.36,"slip":0.88}');
    expect(el.querySelector('[data-testid="new-calibration-done"]')).not.toBeNull();
  });

  it("repeated wheel runs are collected, averaged and given a standard deviation", () => {
    const { el, socket } = mountPage();
    click(el, '[data-testid="new-calibration-start"]');
    click(el, '[data-testid="new-calibration-wheels"]');
    rx(socket, '{"ev":"calwheels.result","calib":0.71,"diameter":81.40,"measured":100,"true":90.5,"error":9.5,"was":0.7878}');
    // One run has no spread -- and says nothing, rather than claiming 0.
    expect(el.querySelector('[data-testid="new-calibration-wheel-stat"]')?.textContent).toContain("1 run");
    expect(el.querySelector('[data-testid="new-calibration-wheel-stat"]')?.textContent).not.toContain("sd");

    click(el, '[data-testid="new-calibration-wheels"]');
    rx(socket, '{"ev":"calwheels.result","calib":0.71,"diameter":81.50,"measured":100,"true":90.5,"error":9.5,"was":0.7878}');
    const stat = el.querySelector('[data-testid="new-calibration-wheel-stat"]')?.textContent ?? "";
    expect(stat).toContain("2 runs");
    expect(stat).toContain("mean 81.45 mm");
    // Sample sd of {81.40, 81.50} is 0.0707...
    expect(stat).toContain("sd 0.071 mm");
    expect(el.querySelector<HTMLInputElement>("#calibration-wheel-diameter")!.value).toBe("81.45");
  });

  it("Done writes the averages to the robot and clears the collection", () => {
    const { el, socket } = mountPage();
    click(el, '[data-testid="new-calibration-start"]');
    click(el, '[data-testid="new-calibration-wheels"]');
    rx(socket, WHEELS);
    click(el, '[data-testid="new-calibration-turns"]');
    rx(socket, '{"ev":"calturn.result","b":8.84,"tw":11.5,"slip":1.301}');

    const before = socket.sent.length;
    click(el, '[data-testid="new-calibration-done"]');
    const after = socket.sent.slice(before).map((raw) => JSON.parse(raw));
    expect(after).toContainEqual(
      expect.objectContaining({ type: "send-command", verb: "SET", fields: ["wheel_diameter", "90.68"] }),
    );
    // ...and the store verb, so it survives the power cycle.
    expect(after.some((msg) => msg.verb === "RUN" && msg.fields?.[0] === "calsave")).toBe(true);
    expect(el.querySelector('[data-testid="new-calibration-written"]')?.textContent).toContain("Written to the robot");
    // Back to Start: the records were only ever there to be averaged.
    expect(el.querySelector('[data-testid="new-calibration-start"]')).not.toBeNull();
  });

  it("a failed run records nothing and says so", () => {
    const { el, socket } = mountPage();
    click(el, '[data-testid="new-calibration-start"]');
    click(el, '[data-testid="new-calibration-wheels"]');
    rx(socket, '{"ev":"calwheels.fail","why":"not on clear white","implied":778}');
    expect(el.querySelector('[data-testid="new-calibration-failure"]')?.textContent).toContain("not on clear white");
    expect(el.querySelector('[data-testid="new-calibration-failure"]')?.textContent).toContain("Nothing was recorded");
    expect(el.querySelector('[data-testid="new-calibration-turns"]')).toBeNull();
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
      // Also requests `calshow` once, unconditionally -- see the
      // "CalibrationStorePanel" describe block below; unrelated to
      // FUNCS, so this test only asserts FUNCS is among the sends.
      const { socket } = mountPage({ functions: null });
      expect(socket.sent).toContainEqual(JSON.stringify({ type: "send-command", linkId: LINK_ID, verb: "FUNCS" }));
      expect(socket.sent.filter((line) => line.includes('"verb":"FUNCS"'))).toHaveLength(1);
    });

    it("does not request FUNCS when a function list is already known", () => {
      const { socket } = mountPage({ functions: [{ name: "calwheels" }] });
      expect(socket.sent.filter((line) => line.includes('"verb":"FUNCS"'))).toEqual([]);
    });

    it("the flow renders whatever FUNCS listed -- an absent name proves nothing (dropped Wi-Fi burst lines)", () => {
      const { el } = mountPage({ functions: [{ name: "calwheels" }] });
      expect(el.querySelector('[aria-label="New calibration"]')).not.toBeNull();
      expect(el.querySelector('[data-testid="new-calibration-start"]')).not.toBeNull();
    });

    it("the flow renders even when FUNCS lists no calibration functions at all", () => {
      const { el } = mountPage({ functions: [{ name: "line" }, { name: "sense" }] });
      expect(el.querySelector('[data-testid="new-calibration-start"]')).not.toBeNull();
    });

    it("never renders a generic Run button for calsave -- 'Calibrate save' means nothing and writes the store", () => {
      const { el } = mountPage({ functions: [{ name: "calwheels" }, { name: "calturn" }, { name: "calsave" }] });
      expect(el.querySelector('[data-testid="calibration-run-calsave"]')).toBeNull();
      expect(el.textContent).not.toMatch(/Calibrate save/);
    });

    it("renders a generic run control for a cal* function neither wizard owns, labelled from its name, and running it sends a bare RUN", () => {
      const { el, socket } = mountPage({ functions: [{ name: "calwheels" }, { name: "calturn" }, { name: "calb" }] });
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

  describe("the retired rows (stakeholder, 2026-09-19: four values, no more)", () => {
    it("a turn run fills the effective width and no longer surfaces the boot record or a second slip", () => {
      const { el, socket } = mountPage();
      click(el, '[data-testid="new-calibration-start"]');
      click(el, '[data-testid="new-calibration-wheels"]');
      rx(socket, WHEELS);
      click(el, '[data-testid="new-calibration-turns"]');
      rx(socket, '{"ev":"calturn.result","b":8.84,"tw":11.16,"slip":1.008}');

      expect(el.querySelector('[data-testid="calibration-effective-track"]')?.textContent).toContain("8.84 cm");
      // `tw` is a baked boot record, not a measurement, and a second
      // slip beside the computed one only ever raised the question of
      // which was real.
      expect(el.querySelector('[data-testid="calibration-robot-track-width"]')).toBeNull();
      expect(el.querySelector('[data-testid="calibration-firmware-slip"]')).toBeNull();
      expect(el.textContent).not.toMatch(/Robot's own track width/);
    });

    it("with no caliper entry the slip is 1, and says why -- directly under the effective width it is using", () => {
      const { el, socket } = mountPage();
      click(el, '[data-testid="new-calibration-start"]');
      click(el, '[data-testid="new-calibration-wheels"]');
      rx(socket, WHEELS);
      click(el, '[data-testid="new-calibration-turns"]');
      rx(socket, '{"ev":"calturn.result","b":8.84,"tw":11.16,"slip":1.008}');
      expect(el.querySelector('[data-testid="calibration-slip"]')?.textContent).toContain(
        "no measured track width, so the effective width is used as the track",
      );

      type(el, "calibration-track-width", "11.16");
      expect(el.querySelector('[data-testid="calibration-slip"]')?.textContent).toContain("11.16 ÷ 8.84");
    });
  });

  describe("profile calibration-0.20260919.4: calshow-fed store panel, page-level 'still missing' banner, and calshow refresh after a wizard run", () => {
    it("no longer mounts a separate stored-calibration panel -- the stored values ARE the current calibration", () => {
      const { el, socket } = mountPage();
      expect(el.querySelector('[data-testid="calibration-store-panel"]')).toBeNull();
      // calshow is still asked for on connect: it is where the current
      // calibration comes from for a robot this browser never measured.
      expect(socket.sent.some((line) => line.includes('"fields":["calshow"]'))).toBe(true);
    });

    it("names the still-missing calibration on the page itself, once calshow has answered, and drops it once both are known", () => {
      const { el, socket } = mountPage();
      rx(socket, '{"ev":"calstore.values","wheel":0,"tw":0,"slip":0,"has_wheel":0,"has_turn":0,"live_tw":11.5,"live_slip":1}');
      const missing = el.querySelector('[data-testid="calibration-code-missing"]')!;
      expect(missing.textContent).toContain("wheel calibration");
      expect(missing.textContent).toContain("rotation calibration");
      // And the generated code now uses the compiled defaults rather
      // than staying empty, since calshow has genuinely answered.
      expect(el.querySelector('[data-testid="calibration-code"]')?.textContent).toContain("NOT measured");

      rx(socket, '{"ev":"calstore.values","wheel":0.7856,"tw":11.42,"slip":1.008,"has_wheel":1,"has_turn":1,"live_tw":11.42,"live_slip":1.008}');
      expect(el.querySelector('[data-testid="calibration-code-missing"]')).toBeNull();
    });

    it("does not claim anything is missing before calshow has answered -- only that this session's own state is incomplete", () => {
      const { el } = mountPage();
      expect(el.querySelector('[data-testid="calibration-code-missing"]')).toBeNull();
    });

    it("a succeeded wheel run re-asks calshow, so the current calibration doesn't go stale", () => {
      const { el, socket } = mountPage();
      click(el, '[data-testid="new-calibration-start"]');
      const before = socket.sent.filter((line) => line.includes('"fields":["calshow"]')).length;
      click(el, '[data-testid="new-calibration-wheels"]');
      rx(socket, WHEELS);
      const after = socket.sent.filter((line) => line.includes('"fields":["calshow"]')).length;
      expect(after).toBeGreaterThan(before);
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
          firmware: {
            relay: { configured: false },
            robot: { configured: true, repoUrl: "https://x", tag: "latest", available: true, checkedAt: 1000 },
          },
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

  it("console on the LEFT, the things you press on the right (stakeholder, 2026-09-19)", () => {
    const { el } = mountPage();
    const left = el.querySelector(".robot-page-column-left")!;
    const right = el.querySelector(".robot-page-column-right")!;

    // The console is what you watch while a run happens, so it gets the
    // viewport-bound column class and the left side.
    expect(left.classList.contains("robot-page-column-console")).toBe(true);
    expect(left.contains(el.querySelector('[aria-label="Console"]')!)).toBe(true);

    // Everything you act on -- the flow, the values, the code -- is on
    // the right, in that order.
    expect(right.contains(el.querySelector('[aria-label="New calibration"]')!)).toBe(true);
    expect(right.contains(el.querySelector('[aria-label="Current calibration"]')!)).toBe(true);
    expect(right.contains(el.querySelector('[aria-label="Calibration code"]')!)).toBe(true);
  });

  it("the how-to is behind a button, not inline on the page", () => {
    const { el } = mountPage();
    expect(el.querySelector('[data-testid="calibration-help"]')).toBeNull();
    expect(el.textContent).not.toMatch(/iron cross/i);

    click(el, '[data-testid="calibration-help-open"]');
    const help = el.querySelector('[data-testid="calibration-help"]')!;
    expect(help.getAttribute("role")).toBe("dialog");
    expect(help.textContent).toMatch(/iron cross/i);

    click(el, '[data-testid="calibration-help-close"]');
    expect(el.querySelector('[data-testid="calibration-help"]')).toBeNull();
  });
});

describe("generic cal* controls stay out of the way", () => {
  // The stakeholder saw "Calibrate show / Run" and "Calibrate clear /
  // Run" rendered as full-width panels, twice each, and asked what they
  // were for. They were auto-generated from FUNCS for any cal* verb
  // without a dedicated wizard -- so calshow and calclear, which the
  // page already drives for itself, appeared as a second, unguarded way
  // to do the same thing.
  it("never renders a generic Run control for calshow or calclear", () => {
    const { el } = mountPage({ functions: [{ name: "calwheels" }, { name: "calturn" }, { name: "calshow" }, { name: "calclear" }] });
    expect(el.querySelector('[data-testid="calibration-run-calshow"]')).toBeNull();
    expect(el.querySelector('[data-testid="calibration-run-calclear"]')).toBeNull();
  });

  it("renders one control per name even if FUNCS reports a name twice", () => {
    // An older host build accumulates FUNCS replies (fixed in 26c5d57),
    // and a duplicate here is both an ugly repeated row and a colliding
    // React key.
    const { el } = mountPage({ functions: [{ name: "calfoo" }, { name: "calfoo" }] });
    expect(el.querySelectorAll('[data-testid="calibration-run-calfoo"]')).toHaveLength(1);
  });

  it("still offers a control for a cal* verb this page has no wizard for", () => {
    const { el } = mountPage({ functions: [{ name: "calwheels" }, { name: "calfoo" }] });
    expect(el.querySelector('[data-testid="calibration-run-calfoo"]')).not.toBeNull();
  });
});
