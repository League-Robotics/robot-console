// @vitest-environment jsdom
/**
 * DistanceCalibrationWizard.test.tsx — component tests for ticket 003's
 * distance-calibration wizard (SUC-003; migrated to the `Snapshot`
 * contract and its on-open probe removed, sprint 015 ticket 009).
 *
 * Covers every acceptance criterion: the `calx`-gated availability split
 * into two distinct "not asked yet" / "answered without calx" messages,
 * the setup instructions, the `RUN calx` dispatch on Go, progressive
 * rendering of `CALX:` lines via `CalibrationReport`, the terminal
 * `apply` line rendered verbatim as the snippet, a `CALX:fail` line's
 * distinct failure state (never a snippet), a `RUN` `err 1` reply's own
 * distinct state, and the regression check that no nudge/beam-pointer UI
 * ever appears in this panel.
 *
 * Ticket 009 deletes the "fires a one-shot FUNCS probe on mount" pinned
 * test case this file used to carry, not adapting it: this panel no
 * longer sends `FUNCS` on its own at all, on mount or on reopen -- it
 * only reads whatever `link.session.functions` the snapshot already
 * reports.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { RobotFunction, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { DistanceCalibrationWizard, deriveBaselineDiameterMm, deriveWheelDiameterMm, wheelDiameterSnippet } from "./DistanceCalibrationWizard";
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

function linkWithFunctions(functions: RobotFunction[] | undefined, overrides: Partial<SnapshotLink> = {}): SnapshotLink {
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
    session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: functions ?? null },
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

function mountWizard(link: SnapshotLink): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <DistanceCalibrationWizard link={link} />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket! };
}

function clickGo(el: HTMLDivElement): void {
  act(() => {
    el.querySelector<HTMLButtonElement>('[data-testid="distance-calibration-go"]')!.click();
  });
}

function emitLine(socket: FakeSocket, line: string): void {
  act(() => {
    socket.emitMessage({ type: "line", linkId: LINK_ID, direction: "rx", line });
  });
}

describe("DistanceCalibrationWizard availability", () => {
  it("stakeholder 2026-09-13: before any FUNCS reply the Calibrate X button is present and enabled (an unanswered FUNCS never blocks the run)", () => {
    const { el } = mountWizard(linkWithFunctions(undefined));
    expect(el.querySelector('[data-testid="distance-calibration-idle"]')).toBeNull();
    expect(el.querySelector('[data-testid="distance-calibration-unavailable"]')).toBeNull();
    const go = el.querySelector<HTMLButtonElement>('[data-testid="distance-calibration-go"]')!;
    expect(go.textContent).toBe("Calibrate X");
    expect(go.disabled).toBe(false);
  });

  it("shows the non-alarming unavailable message and keeps Go disabled when FUNCS answers without calx", () => {
    const { el } = mountWizard(linkWithFunctions([{ name: "abort" }, { name: "sense" }]));
    const hint = el.querySelector('[data-testid="distance-calibration-unavailable"]');
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toContain("doesn't support calibration yet");
    expect(el.querySelector('[data-testid="distance-calibration-idle"]')).toBeNull();
    expect(el.querySelector<HTMLButtonElement>('[data-testid="distance-calibration-go"]')!.disabled).toBe(true);
    // Never a spinner -- this is a plain status paragraph, not a
    // loading/progress element.
    expect(el.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("shows the 90cm setup instructions and enables Go once calx is present", () => {
    const { el } = mountWizard(linkWithFunctions([{ name: "calx" }, { name: "cala" }]));
    const setup = el.querySelector('[data-testid="distance-calibration-setup"]');
    expect(setup).not.toBeNull();
    expect(setup!.textContent).toContain("90 cm");
    expect(el.querySelector<HTMLButtonElement>('[data-testid="distance-calibration-go"]')!.disabled).toBe(false);
  });

  it("disables Go when there is no open session even with calx available", () => {
    const { el } = mountWizard(closedLink());
    expect(el.querySelector<HTMLButtonElement>('[data-testid="distance-calibration-go"]')!.disabled).toBe(true);
  });
});

describe("DistanceCalibrationWizard run dispatch", () => {
  it("sends RUN calx via sendCommand when Go is pressed", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calx" }]));
    socket.sent.length = 0;
    clickGo(el);
    expect(socket.sent).toEqual([JSON.stringify({ type: "send-command", linkId: LINK_ID, verb: "RUN", fields: ["calx"] })]);
  });

  it("hides the setup instructions and disables Go once a run is in flight", () => {
    const { el } = mountWizard(linkWithFunctions([{ name: "calx" }]));
    clickGo(el);
    expect(el.querySelector('[data-testid="distance-calibration-setup"]')).toBeNull();
    expect(el.querySelector<HTMLButtonElement>('[data-testid="distance-calibration-go"]')!.disabled).toBe(true);
  });
});

describe("DistanceCalibrationWizard progress rendering", () => {
  it("renders distinct, visible progress states as CALX: lines stream in -- not one generic spinner", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calx" }]));
    clickGo(el);

    emitLine(socket, "CALX:begin true=90cm baseline=0.7878mm/deg");
    let progress = el.querySelector('[data-testid="distance-calibration-progress"]')!;
    expect(progress.textContent).toContain("begin true=90cm baseline=0.7878mm/deg");

    emitLine(socket, "CALX:start line found");
    progress = el.querySelector('[data-testid="distance-calibration-progress"]')!;
    expect(progress.textContent).toContain("start line found");
    // Both distinct lines are visible at once, not collapsed into one
    // generic "running" word.
    expect(progress.textContent).toContain("begin true=90cm baseline=0.7878mm/deg");
  });

  it("tolerates interleaved noise (acks, unrelated debug lines) without disturbing progress", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calx" }]));
    clickGo(el);
    emitLine(socket, "ack 5 0 none");
    emitLine(socket, "CALX:begin true=90cm baseline=0.7878mm/deg");
    emitLine(socket, "DBG: loop=12");
    emitLine(socket, "CALX:start line found");

    const progress = el.querySelector('[data-testid="distance-calibration-progress"]')!;
    expect(progress.textContent).toContain("begin true=90cm baseline=0.7878mm/deg");
    expect(progress.textContent).toContain("start line found");
    expect(el.querySelector('[data-testid="distance-calibration-run-error"]')).toBeNull();
    expect(el.querySelector('[data-testid="distance-calibration-failed"]')).toBeNull();
  });
});

describe("DistanceCalibrationWizard terminal states", () => {
  it("OOP 2026-09-10: reports the wheel diameter from CALX:diameter and hands out code written in terms of that diameter", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calx" }]));
    clickGo(el);
    emitLine(socket, "CALX:begin true=90cm baseline=0.7878mm/deg");
    emitLine(socket, "CALX:start line found");
    emitLine(socket, "CALX:measured=89.61cm true=90cm error=-0.39cm");
    emitLine(socket, "CALX:calib=0.7912 mm/deg  (was 0.7878)");
    emitLine(socket, "CALX:diameter=90.68 mm");
    emitLine(socket, "CALX:apply diffDrive.setWheelCalibration(0.7912)");

    const diameter = el.querySelector('[data-testid="distance-calibration-diameter"]')!;
    expect(diameter.textContent).toBe("Wheel diameter: 90.68 mm (was 90.28 mm)");
    // The paste-ready code now lives in CalibrationPage's single block;
    // the wizard just shows what the robot itself reported.
    const snippet = el.querySelector('[data-testid="distance-calibration-snippet"]')!;
    expect(snippet.textContent).toBe("diffDrive.setWheelCalibration(0.7912)");
    expect(el.querySelector('[data-testid="distance-calibration-failed"]')).toBeNull();
    expect(el.querySelector('[data-testid="distance-calibration-run-error"]')).toBeNull();
    // Go re-enables so the student can run again if they want to.
    expect(el.querySelector<HTMLButtonElement>('[data-testid="distance-calibration-go"]')!.disabled).toBe(false);
  });

  it("renders a distinct failure state on a CALX:fail line, never a snippet", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calx" }]));
    clickGo(el);
    emitLine(socket, "CALX:begin true=90cm baseline=0.7878mm/deg");
    emitLine(socket, "CALX:fail no start line within 60cm");

    const failed = el.querySelector('[data-testid="distance-calibration-failed"]')!;
    expect(failed).not.toBeNull();
    expect(failed.textContent).toContain("no start line within 60cm");
    expect(el.querySelector('[data-testid="distance-calibration-snippet"]')).toBeNull();
    expect(el.querySelector('[data-testid="distance-calibration-run-error"]')).toBeNull();
  });

  it("renders a distinct 'run rejected' state on a RUN err 1 reply, never confused with CALX:fail or unavailable", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calx" }]));
    clickGo(el);
    emitLine(socket, "err 1 #1");

    const runError = el.querySelector('[data-testid="distance-calibration-run-error"]')!;
    expect(runError).not.toBeNull();
    expect(el.querySelector('[data-testid="distance-calibration-failed"]')).toBeNull();
    expect(el.querySelector('[data-testid="distance-calibration-unavailable"]')).toBeNull();
    expect(el.querySelector('[data-testid="distance-calibration-snippet"]')).toBeNull();
  });

  it("falls back to the firmware's raw snippet, with no diameter line, when nothing derivable was sent", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calx" }]));
    clickGo(el);
    emitLine(socket, "CALX:apply diffDrive.somethingNew(42)");
    expect(el.querySelector('[data-testid="distance-calibration-diameter"]')).toBeNull();
    expect(el.querySelector('[data-testid="distance-calibration-snippet"]')!.textContent).toBe("diffDrive.somethingNew(42)");
  });
});

describe("DistanceCalibrationWizard with the apply line dropped over WiFi (OOP 2026-09-10)", () => {
  it("reaches the result from CALX:calib + CALX:diameter when CALX:apply never arrives", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calx" }]));
    clickGo(el);
    emitLine(socket, "CALX:begin true=90cm baseline=0.7878mm/deg");
    emitLine(socket, "CALX:measured=89.61cm true=90cm error=-0.39cm");
    emitLine(socket, "CALX:calib=0.7912 mm/deg  (was 0.7878)");
    expect(el.querySelector('[data-testid="distance-calibration-snippet"]')).toBeNull();
    emitLine(socket, "CALX:diameter=90.68 mm");
    expect(el.querySelector('[data-testid="distance-calibration-diameter"]')?.textContent).toBe("Wheel diameter: 90.68 mm (was 90.28 mm)");
    expect(el.querySelector('[data-testid="distance-calibration-snippet"]')?.textContent).toBe(
      "diffDrive.setWheelCalibration(0.7912)",
    );
  });
});

describe("DistanceCalibrationWizard in a long-lived tab (OOP 2026-09-10 regression)", () => {
  it("still reaches the result when the log ring was already full at Go", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calx" }]));
    act(() => {
      for (let i = 0; i < 520; i += 1) {
        socket.emitMessage({ type: "line", linkId: LINK_ID, direction: "rx", line: `status ready=1 cyc=${i}` });
      }
    });
    clickGo(el);
    emitLine(socket, "CALX:begin true=90cm baseline=0.7878mm/deg");
    emitLine(socket, "CALX:diameter=90.68 mm");
    emitLine(socket, "CALX:apply diffDrive.setWheelCalibration(0.7912)");
    expect(el.querySelector('[data-testid="distance-calibration-diameter"]')?.textContent).toBe(
      "Wheel diameter: 90.68 mm (was 90.28 mm)",
    );
  });
});

describe("DistanceCalibrationWizard regression: no nudge/beam-pointer UI", () => {
  it("never renders a nudge control or beam-pointer affordance in any state", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calx" }]));
    expect(el.textContent).not.toMatch(/nudge/i);
    expect(el.textContent).not.toMatch(/beam/i);

    clickGo(el);
    emitLine(socket, "CALX:begin true=90cm baseline=0.7878mm/deg");
    expect(el.textContent).not.toMatch(/nudge/i);
    expect(el.textContent).not.toMatch(/beam/i);

    emitLine(socket, "CALX:apply diffDrive.setWheelCalibration(0.79)");
    expect(el.textContent).not.toMatch(/nudge/i);
    expect(el.textContent).not.toMatch(/beam/i);
  });
});
