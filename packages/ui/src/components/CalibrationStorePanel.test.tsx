// @vitest-environment jsdom
/**
 * CalibrationStorePanel.test.tsx — component tests for the `calshow`/
 * `calclear` store panel (profile calibration-0.20260919.4; see
 * `CalibrationStorePanel.tsx`'s own doc comment for the use case this
 * covers: a robot calibrated from its own A/B menu, with no computer
 * attached, plugged into this browser cold).
 *
 * Covers: `calshow` sent once on connect, the four has_wheel/has_turn
 * combinations (never a blank/zero for "not calibrated"), `runs === 1`
 * reading visibly differently from `runs >= 2`, the two-step
 * arm/confirm `calclear` flow (never a bare `window.confirm`) and its
 * "cleared" confirmation text, the manual Refresh control, and the
 * `boot cal ...` line's opportunistic-hint-only status (never
 * authoritative once `calshow` answers).
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { CalibrationStorePanel } from "./CalibrationStorePanel";
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

const LINK_ID = "usb-ROBOT-A";

function link(overrides: Partial<SnapshotLink> = {}): SnapshotLink {
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
    session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: [{ name: "calshow" }, { name: "calclear" }] },
    ...overrides,
  };
}

function closedLink(): SnapshotLink {
  return {
    id: LINK_ID,
    transport: "usb",
    label: "USB · /dev/cu.usbmodemC",
    state: "connectable",
    reason: null,
    since: 0,
    lastSeen: 0,
    nextRetryAt: null,
    capabilities: { open: true, close: false, flash: true, provisionWifi: false },
  };
}

function mountPanel(theLink: SnapshotLink = link()): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <CalibrationStorePanel link={theLink} />
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

const BOTH_VALUES =
  '{"ev":"calstore.values","wheel":0.7856,"tw":11.42,"slip":1.008,"has_wheel":1,"has_turn":1,"live_tw":11.42,"live_slip":1.008}';
const ONLY_WHEEL_VALUES =
  '{"ev":"calstore.values","wheel":0.7856,"tw":0,"slip":0,"has_wheel":1,"has_turn":0,"live_tw":11.5,"live_slip":1}';
const ONLY_TURN_VALUES =
  '{"ev":"calstore.values","wheel":0,"tw":11.42,"slip":1.008,"has_wheel":0,"has_turn":1,"live_tw":11.42,"live_slip":1.008}';
const NEITHER_VALUES =
  '{"ev":"calstore.values","wheel":0,"tw":0,"slip":0,"has_wheel":0,"has_turn":0,"live_tw":11.5,"live_slip":1}';

describe("CalibrationStorePanel", () => {
  it("sends calshow exactly once when the link opens usable", () => {
    const { socket } = mountPanel();
    expect(socket.sent.filter((line) => line.includes('"fields":["calshow"]'))).toHaveLength(1);
  });

  it("does not send calshow, and shows an idle hint, when the link isn't usable", () => {
    const { el, socket } = mountPanel(closedLink());
    expect(socket.sent).toEqual([]);
    expect(el.querySelector('[data-testid="calibration-store-idle"]')).not.toBeNull();
    expect(el.querySelector<HTMLButtonElement>('[data-testid="calibration-store-refresh"]')!.disabled).toBe(true);
  });

  it("shows 'asking' before calshow answers, then both calibrations once calstore.values/.runs arrive", () => {
    const { el, socket } = mountPanel();
    expect(el.querySelector('[data-testid="calibration-store-waiting"]')?.textContent).toContain("Asking the robot");

    rx(socket, BOTH_VALUES);
    rx(socket, '{"ev":"calstore.runs","wheel_runs":3,"turn_runs":2,"wheel_mean":90.1,"wheel_lo":89.9,"wheel_hi":90.3,"wheel_spread":0.44}');

    expect(el.querySelector('[data-testid="calibration-store-waiting"]')).toBeNull();
    expect(el.querySelector('[data-testid="calibration-store-wheel-value"]')?.textContent).toContain("mm");
    expect(el.querySelector('[data-testid="calibration-store-turn-value"]')?.textContent).toContain("11.42 cm");
    expect(el.querySelector('[data-testid="calibration-store-turn-value"]')?.textContent).toContain("1.008");
  });

  it("only-wheel-stored: wheel shows a value, turn explicitly says not calibrated yet -- never a default standing in", () => {
    const { el, socket } = mountPanel();
    rx(socket, ONLY_WHEEL_VALUES);
    expect(el.querySelector('[data-testid="calibration-store-wheel-value"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="calibration-store-wheel-missing"]')).toBeNull();
    expect(el.querySelector('[data-testid="calibration-store-turn-value"]')).toBeNull();
    expect(el.querySelector('[data-testid="calibration-store-turn-missing"]')?.textContent).toContain("Not calibrated yet");
  });

  it("only-turn-stored: turn shows a value, wheel explicitly says not calibrated yet", () => {
    const { el, socket } = mountPanel();
    rx(socket, ONLY_TURN_VALUES);
    expect(el.querySelector('[data-testid="calibration-store-turn-value"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="calibration-store-wheel-value"]')).toBeNull();
    expect(el.querySelector('[data-testid="calibration-store-wheel-missing"]')?.textContent).toContain("Not calibrated yet");
  });

  it("neither stored: both explicitly say not calibrated yet, never blank", () => {
    const { el, socket } = mountPanel();
    rx(socket, NEITHER_VALUES);
    expect(el.querySelector('[data-testid="calibration-store-wheel-missing"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="calibration-store-turn-missing"]')).not.toBeNull();
  });

  it("both stored: both show a value", () => {
    const { el, socket } = mountPanel();
    rx(socket, BOTH_VALUES);
    expect(el.querySelector('[data-testid="calibration-store-wheel-value"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="calibration-store-turn-value"]')).not.toBeNull();
  });

  describe("runs=1 reads differently from runs=4", () => {
    it("a single run gets the warning callout naming the known spread and suggesting another run", () => {
      const { el, socket } = mountPanel();
      rx(socket, BOTH_VALUES);
      rx(socket, '{"ev":"calstore.runs","wheel_runs":1,"turn_runs":1}');

      const wheelRuns = el.querySelector('[data-testid="calibration-store-wheel-runs"]')!;
      expect(wheelRuns.classList.contains("calibration-store-runs-single")).toBe(true);
      expect(wheelRuns.textContent).toContain("1 run");
      expect(wheelRuns.textContent).toContain("Run it again");

      const turnRuns = el.querySelector('[data-testid="calibration-store-turn-runs"]')!;
      expect(turnRuns.classList.contains("calibration-store-runs-single")).toBe(true);
    });

    it("several runs get a plain, unremarkable line with the range/spread, not the warning treatment", () => {
      const { el, socket } = mountPanel();
      rx(socket, BOTH_VALUES);
      // wheel_lo/wheel_hi come off the wire in **mm per shaft degree**,
      // the same units as `wheel` itself -- the firmware session's own
      // measured samples "spanning 0.7800 to 0.7896" are the reference.
      // This fixture previously supplied 89.9/90.3, i.e. diameters,
      // which the firmware never sends. The panel converts to diameters
      // for display so the range is comparable to the headline above it.
      rx(
        socket,
        '{"ev":"calstore.runs","wheel_runs":4,"turn_runs":3,"wheel_lo":0.7846,"wheel_hi":0.7881,"wheel_spread":0.44,"turn_lo":11.3,"turn_hi":11.5,"turn_spread":1.8}',
      );

      const wheelRuns = el.querySelector('[data-testid="calibration-store-wheel-runs"]')!;
      expect(wheelRuns.classList.contains("calibration-store-runs-settled")).toBe(true);
      expect(wheelRuns.classList.contains("calibration-store-runs-single")).toBe(false);
      expect(wheelRuns.textContent).toContain("4 runs");
      // 0.7846 mm/deg is ~89.9 mm of diameter; 0.7881 is ~90.3 mm.
      expect(wheelRuns.textContent).toContain("89.9");
      expect(wheelRuns.textContent).toContain("90.3");
      // The raw mm/deg values must not be shown as though they were mm.
      expect(wheelRuns.textContent).not.toContain("0.7846");

      const turnRuns = el.querySelector('[data-testid="calibration-store-turn-runs"]')!;
      expect(turnRuns.classList.contains("calibration-store-runs-settled")).toBe(true);
      expect(turnRuns.textContent).toContain("3 runs");
    });

    it("renders nothing when a run count is zero or unknown", () => {
      const { el, socket } = mountPanel();
      rx(socket, BOTH_VALUES);
      rx(socket, '{"ev":"calstore.runs","wheel_runs":0,"turn_runs":0}');
      expect(el.querySelector('[data-testid="calibration-store-wheel-runs"]')).toBeNull();
      expect(el.querySelector('[data-testid="calibration-store-turn-runs"]')).toBeNull();
    });
  });

  describe("calclear -- confirmed before firing, clears run stats too", () => {
    it("does not send RUN calclear on the first click -- shows a confirm step instead", () => {
      const { el, socket } = mountPanel();
      rx(socket, BOTH_VALUES);
      click(el, '[data-testid="calibration-store-clear"]');
      expect(socket.sent.some((line) => line.includes("calclear"))).toBe(false);
      const confirm = el.querySelector('[data-testid="calibration-store-clear-confirm"]')!;
      expect(confirm).not.toBeNull();
      expect(confirm.textContent).toContain("run statistics");
      expect(confirm.textContent).toContain("irreversible");
    });

    it("Cancel dismisses the confirm step without sending anything", () => {
      const { el, socket } = mountPanel();
      rx(socket, BOTH_VALUES);
      click(el, '[data-testid="calibration-store-clear"]');
      click(el, '[data-testid="calibration-store-clear-cancel"]');
      expect(el.querySelector('[data-testid="calibration-store-clear-confirm"]')).toBeNull();
      expect(socket.sent.some((line) => line.includes("calclear"))).toBe(false);
    });

    it("confirming sends RUN calclear, and a calstore.cleared reply shows the cleared confirmation", () => {
      const { el, socket } = mountPanel();
      rx(socket, BOTH_VALUES);
      click(el, '[data-testid="calibration-store-clear"]');
      click(el, '[data-testid="calibration-store-clear-confirm-yes"]');
      expect(socket.sent).toContainEqual(JSON.stringify({ type: "send-command", linkId: LINK_ID, verb: "RUN", fields: ["calclear"] }));
      expect(el.querySelector('[data-testid="calibration-store-clear-confirm"]')).toBeNull();

      rx(socket, '{"ev":"calstore.cleared"}');
      expect(el.querySelector('[data-testid="calibration-store-cleared"]')?.textContent).toContain("run statistics are gone");
      expect(el.querySelector('[data-testid="calibration-store-wheel-value"]')).toBeNull();
      expect(el.querySelector('[data-testid="calibration-store-turn-value"]')).toBeNull();
    });
  });

  it("the Refresh button re-sends calshow on demand", () => {
    const { el, socket } = mountPanel();
    const before = socket.sent.filter((line) => line.includes('"fields":["calshow"]')).length;
    click(el, '[data-testid="calibration-store-refresh"]');
    const after = socket.sent.filter((line) => line.includes('"fields":["calshow"]')).length;
    expect(after).toBe(before + 1);
  });

  describe("the boot cal line is an opportunistic hint only, never authoritative once calshow answers", () => {
    it("shows the boot hint's numbers, marked unconfirmed, before calshow answers", () => {
      const { el, socket } = mountPanel();
      rx(socket, "boot cal wheel=0.7878 tw=11.42 slip=1.0 runs=3/1");
      expect(el.querySelector('[data-testid="calibration-store-wheel-hint"]')?.textContent).toContain("unconfirmed");
      expect(el.querySelector('[data-testid="calibration-store-turn-hint"]')?.textContent).toContain("11.42 cm");
    });

    it("boot cal none stored shows the 'neither stored at boot' waiting text, not a hint value", () => {
      const { el, socket } = mountPanel();
      rx(socket, "boot cal none stored");
      expect(el.querySelector('[data-testid="calibration-store-waiting"]')?.textContent).toContain("neither calibration stored");
      expect(el.querySelector('[data-testid="calibration-store-wheel-hint"]')).toBeNull();
    });

    it("a real calstore.values answer supersedes the boot hint outright", () => {
      const { el, socket } = mountPanel();
      rx(socket, "boot cal wheel=0.7878 tw=11.42 slip=1.0 runs=3/1");
      rx(socket, NEITHER_VALUES);
      expect(el.querySelector('[data-testid="calibration-store-wheel-hint"]')).toBeNull();
      expect(el.querySelector('[data-testid="calibration-store-wheel-missing"]')).not.toBeNull();
    });
  });
});

describe("wheel run range units", () => {
  // Caught in a browser walk: the panel put "Wheel diameter: 90.02 mm"
  // directly above "range 0.78-0.7896 mm". Both wore "mm", but the
  // stored wheel value and its run statistics are in mm per shaft
  // DEGREE, not millimetres of diameter -- so the range read as
  // nonsense next to the headline it belongs to.
  it("shows the wheel run range as diameters, comparable to the headline", () => {
    const { el, socket } = mountPanel();
    rx(socket, BOTH_VALUES);
    rx(
      socket,
      '{"ev":"calstore.runs","wheel_runs":4,"wheel_mean":0.7848,"wheel_lo":0.78,"wheel_hi":0.7896,"wheel_spread":1.2,"turn_runs":3}',
    );

    const text = el.querySelector('[data-testid="calibration-store-wheel-runs"]')?.textContent ?? "";
    // 0.78 mm/deg is ~89.4 mm of diameter; 0.7896 is ~90.5 mm.
    expect(text).toMatch(/89\.[0-9]/);
    expect(text).toMatch(/90\.[0-9]/);
    // The raw mm/deg numbers must not appear as though they were mm.
    expect(text).not.toContain("0.78");
    expect(text).not.toContain("0.7896");
    // The spread is scale-invariant and stays as reported.
    expect(text).toContain("1.2%");
  });
});
