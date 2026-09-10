// @vitest-environment jsdom
/**
 * RotationCalibrationWizard.test.tsx — component tests for ticket 004's
 * rotation-calibration wizard (SUC-004).
 *
 * Mirrors `DistanceCalibrationWizard.test.tsx`'s structure exactly:
 * the one-shot `FUNCS` probe on mount, the `cala`-gated availability
 * split into two distinct "not asked yet" / "answered without cala"
 * messages, the black-tape-cross setup instructions (no beam pointer,
 * no nudging), the `RUN cala` dispatch on Go, progressive rendering of
 * `CALA:` lines as four distinct pass stages (not collapsed into one
 * spinner), the terminal `apply` line rendered verbatim as the
 * snippet, a `CALA:fail` line's distinct failure state (at various
 * stages, not just the first), a `RUN` `err 1` reply's own distinct
 * state, a second run after a completed one, and the regression check
 * that no nudge/beam-pointer UI ever appears in this panel.
 *
 * Marker and progress-line text throughout is taken verbatim from
 * `test/calibratea.ts` (`nezha-robot-template`, read directly) --
 * `CALA:pass clockwise`, `CALA:pass counter-clockwise`, `CALA:check
 * clockwise`, `CALA:check counter-clockwise`, and representative
 * `CALA:armed .../CALA:edge .../CALA:centring .../CALA:fail ...` text.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { EndpointListEntry, RobotFunction } from "@robot-console/host/src/wsMessages.js";
import { RotationCalibrationWizard, deriveRotationCalibrationRun } from "./RotationCalibrationWizard";
import { WsProvider, useWsActions } from "../ws/WsProvider";
import { FakeSocket } from "../testing/FakeSocket";

/** A minimal stand-in for `DeviceConsole`'s own "Clear log" button --
 * mounted alongside the wizard under the same `WsProvider` so a click
 * here exercises the exact `clearEndpointLog` action a real "Clear
 * log" press would fire, without pulling in the whole console. */
function ClearLogButton({ endpointId }: { endpointId: string }) {
  const { clearEndpointLog } = useWsActions();
  return (
    <button type="button" data-testid="test-clear-log" onClick={() => clearEndpointLog(endpointId)}>
      Clear log
    </button>
  );
}

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

function baseDevice(
  functions: RobotFunction[] | undefined,
  overrides: Partial<EndpointListEntry> = {},
): EndpointListEntry {
  return {
    endpointId: "usb-ROBOT-A",
    transport: "usb",
    resourceKey: "usb-ROBOT-A",
    classification: { type: "robot", role: "NEZHA2", commonName: "robot", dialect: "space", evidence: "role", program: null, version: null },
    name: "zavaz",
    role: "NEZHA2",
    sessionOpen: true,
    usb: { serialNumber: "ROBOT-A-FULL", displaySerial: "0004", port: "/dev/cu.usbmodemC" },
    // `exactOptionalPropertyTypes` forbids `functions: undefined` -- the
    // key must be entirely absent to represent "no FUNCS sent yet".
    ...(functions !== undefined ? { functions } : {}),
    ...overrides,
  };
}

function mountWizard(device: EndpointListEntry): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <RotationCalibrationWizard device={device} />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket! };
}

/**
 * Mounts `WsProvider` with its socket already open *before* the wizard
 * ever renders -- see `DistanceCalibrationWizard.test.tsx`'s identical
 * `mountReady` for the full rationale.
 */
function mountReady(device: EndpointListEntry): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const socketFactory = () => (socket = new FakeSocket());
  const url = "ws://test/";
  const el = mount(
    <WsProvider url={url} socketFactory={socketFactory}>
      <div />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  act(() => {
    root!.render(
      <WsProvider url={url} socketFactory={socketFactory}>
        <RotationCalibrationWizard device={device} />
      </WsProvider>,
    );
  });
  return { el, socket: socket! };
}

function mountWizardWithClear(device: EndpointListEntry): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <RotationCalibrationWizard device={device} />
      <ClearLogButton endpointId={device.endpointId} />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket! };
}

function clickGo(el: HTMLDivElement): void {
  act(() => {
    el.querySelector<HTMLButtonElement>('[data-testid="rotation-calibration-go"]')!.click();
  });
}

function emitLine(socket: FakeSocket, line: string): void {
  act(() => {
    socket.emitMessage({ type: "line", endpointId: "usb-ROBOT-A", direction: "rx", line });
  });
}

describe("RotationCalibrationWizard availability", () => {
  it("fires a one-shot FUNCS probe on mount when a session is already open", () => {
    const { socket } = mountReady(baseDevice(undefined));
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", endpointId: "usb-ROBOT-A", verb: "FUNCS" }),
    ]);
  });

  it("shows an idle 'checking' message and disables Go before any FUNCS reply", () => {
    const { el } = mountWizard(baseDevice(undefined));
    expect(el.querySelector('[data-testid="rotation-calibration-idle"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-unavailable"]')).toBeNull();
    expect(el.querySelector<HTMLButtonElement>('[data-testid="rotation-calibration-go"]')!.disabled).toBe(true);
  });

  it("shows the non-alarming unavailable message and keeps Go disabled when FUNCS answers without cala", () => {
    const { el } = mountWizard(baseDevice([{ name: "calx" }, { name: "abort" }]));
    const hint = el.querySelector('[data-testid="rotation-calibration-unavailable"]');
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toContain("doesn't support calibration yet");
    expect(el.querySelector('[data-testid="rotation-calibration-idle"]')).toBeNull();
    expect(el.querySelector<HTMLButtonElement>('[data-testid="rotation-calibration-go"]')!.disabled).toBe(true);
    expect(el.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("shows the black-tape-cross setup instructions and enables Go once cala is present", () => {
    const { el } = mountWizard(baseDevice([{ name: "calx" }, { name: "cala" }]));
    const setup = el.querySelector('[data-testid="rotation-calibration-setup"]');
    expect(setup).not.toBeNull();
    expect(setup!.textContent).toContain("black tape");
    expect(setup!.textContent).toContain("cross");
    expect(el.querySelector<HTMLButtonElement>('[data-testid="rotation-calibration-go"]')!.disabled).toBe(false);
  });

  it("disables Go when there is no open session even with cala available", () => {
    const { el } = mountWizard(baseDevice([{ name: "cala" }], { sessionOpen: false }));
    expect(el.querySelector<HTMLButtonElement>('[data-testid="rotation-calibration-go"]')!.disabled).toBe(true);
  });
});

describe("RotationCalibrationWizard run dispatch", () => {
  it("sends RUN cala via sendCommand when Go is pressed", () => {
    const { el, socket } = mountWizard(baseDevice([{ name: "cala" }]));
    socket.sent.length = 0;
    clickGo(el);
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", endpointId: "usb-ROBOT-A", verb: "RUN", fields: ["cala"] }),
    ]);
  });

  it("hides the setup instructions and disables Go once a run is in flight", () => {
    const { el } = mountWizard(baseDevice([{ name: "cala" }]));
    clickGo(el);
    expect(el.querySelector('[data-testid="rotation-calibration-setup"]')).toBeNull();
    expect(el.querySelector<HTMLButtonElement>('[data-testid="rotation-calibration-go"]')!.disabled).toBe(true);
  });
});

describe("RotationCalibrationWizard progress rendering", () => {
  it("renders the CW pass, CCW pass, and the firmware's own re-verification passes as distinct, visibly separate stages -- not collapsed into one spinner", () => {
    const { el, socket } = mountWizard(baseDevice([{ name: "cala" }]));
    clickGo(el);

    emitLine(socket, "CALA:begin track=11.5cm slip=0.952 b=12.08cm");
    emitLine(socket, "CALA:pass clockwise");
    emitLine(socket, "CALA:armed at 0.4deg");
    emitLine(socket, "CALA:edge 1 at 92.11deg");

    let progress = el.querySelector('[data-testid="rotation-calibration-progress"]')!;
    expect(progress.textContent).toContain("begin track=11.5cm slip=0.952 b=12.08cm");
    let cwStage = el.querySelector('[data-testid="rotation-calibration-stage-cw"]')!;
    expect(cwStage).not.toBeNull();
    expect(cwStage.textContent).toContain("armed at 0.4deg");
    expect(cwStage.textContent).toContain("edge 1 at 92.11deg");
    expect(el.querySelector('[data-testid="rotation-calibration-stage-ccw"]')).toBeNull();

    emitLine(socket, "CALA:pass counter-clockwise");
    emitLine(socket, "CALA:armed at 358.2deg");

    // The CW stage's own content is still visible once the CCW stage
    // begins -- distinct stages accumulate, they don't replace one
    // another.
    cwStage = el.querySelector('[data-testid="rotation-calibration-stage-cw"]')!;
    expect(cwStage.textContent).toContain("edge 1 at 92.11deg");
    const ccwStage = el.querySelector('[data-testid="rotation-calibration-stage-ccw"]')!;
    expect(ccwStage).not.toBeNull();
    expect(ccwStage.textContent).toContain("armed at 358.2deg");

    emitLine(socket, "CALA:check clockwise");
    emitLine(socket, "CALA:check counter-clockwise");

    expect(el.querySelector('[data-testid="rotation-calibration-stage-check-cw"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-stage-check-ccw"]')).not.toBeNull();
    // All four stages visible at once.
    progress = el.querySelector('[data-testid="rotation-calibration-progress"]')!;
    expect(progress.textContent).toContain("Clockwise pass");
    expect(progress.textContent).toContain("Counter-clockwise pass");
    expect(progress.textContent).toContain("Re-verification");
  });

  it("tolerates interleaved noise (acks, unrelated debug lines) without disturbing progress", () => {
    const { el, socket } = mountWizard(baseDevice([{ name: "cala" }]));
    clickGo(el);
    emitLine(socket, "ack 5 0 none");
    emitLine(socket, "CALA:pass clockwise");
    emitLine(socket, "DBG: loop=12");
    emitLine(socket, "CALA:edge 1 at 91deg");

    const cwStage = el.querySelector('[data-testid="rotation-calibration-stage-cw"]')!;
    expect(cwStage.textContent).toContain("edge 1 at 91deg");
    expect(el.querySelector('[data-testid="rotation-calibration-run-error"]')).toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-failed"]')).toBeNull();
  });
});

describe("RotationCalibrationWizard terminal states", () => {
  it("renders a CALA:apply line's exact text as the snippet, byte-for-byte after stripping only 'CALA:apply ', once all four pass stages have streamed in", () => {
    const { el, socket } = mountWizard(baseDevice([{ name: "cala" }]));
    clickGo(el);
    emitLine(socket, "CALA:begin track=11.5cm slip=0.952 b=12.08cm");
    emitLine(socket, "CALA:pass clockwise");
    emitLine(socket, "CALA:edge 1 at 92deg");
    emitLine(socket, "CALA:centring scatter=4.2deg");
    emitLine(socket, "CALA:pass counter-clockwise");
    emitLine(socket, "CALA:edge 1 at 358deg");
    emitLine(socket, "CALA:centring scatter=3.9deg");
    emitLine(socket, "CALA:check clockwise");
    emitLine(socket, "CALA:check counter-clockwise");
    emitLine(socket, "CALA:apply diffDrive.setConfigValue(ConfigField.RotationalSlip, 0.965)");

    const snippet = el.querySelector('[data-testid="rotation-calibration-snippet"]')!;
    expect(snippet.textContent).toBe("diffDrive.setConfigValue(ConfigField.RotationalSlip, 0.965)");
    expect(el.querySelector('[data-testid="rotation-calibration-failed"]')).toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-run-error"]')).toBeNull();
    // Go re-enables so the student can run again if they want to.
    expect(el.querySelector<HTMLButtonElement>('[data-testid="rotation-calibration-go"]')!.disabled).toBe(false);
  });

  it("renders a distinct failure state on a CALA:fail line during the very first pass, never a snippet", () => {
    const { el, socket } = mountWizard(baseDevice([{ name: "cala" }]));
    clickGo(el);
    emitLine(socket, "CALA:pass clockwise");
    emitLine(socket, "CALA:fail saw 3 transitions, need 5 -- STALLED, power-cycle the robot");

    const failed = el.querySelector('[data-testid="rotation-calibration-failed"]')!;
    expect(failed).not.toBeNull();
    expect(failed.textContent).toContain("STALLED, power-cycle the robot");
    expect(el.querySelector('[data-testid="rotation-calibration-snippet"]')).toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-run-error"]')).toBeNull();
  });

  it("renders a distinct failure state on a CALA:fail line during the re-verification pass, not just the first pass", () => {
    // A fail can arrive mid-re-verification, well after the first two
    // passes have already streamed their own progress lines -- exercise
    // that ordering directly, not just a fail on the very first pass.
    const { el, socket } = mountWizard(baseDevice([{ name: "cala" }]));
    clickGo(el);
    emitLine(socket, "CALA:pass clockwise");
    emitLine(socket, "CALA:edge 1 at 90deg");
    emitLine(socket, "CALA:pass counter-clockwise");
    emitLine(socket, "CALA:edge 1 at 270deg");
    emitLine(socket, "CALA:check clockwise");
    emitLine(socket, "CALA:fail gap 61deg before 180 -- missed an arm, re-centre the robot");

    const failed = el.querySelector('[data-testid="rotation-calibration-failed"]')!;
    expect(failed).not.toBeNull();
    expect(failed.textContent).toContain("missed an arm, re-centre the robot");
    expect(el.querySelector('[data-testid="rotation-calibration-snippet"]')).toBeNull();
  });

  it("renders a distinct 'run rejected' state on a RUN err 1 reply, never confused with CALA:fail or unavailable", () => {
    const { el, socket } = mountWizard(baseDevice([{ name: "cala" }]));
    clickGo(el);
    emitLine(socket, "err 1 #1");

    const runError = el.querySelector('[data-testid="rotation-calibration-run-error"]')!;
    expect(runError).not.toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-failed"]')).toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-unavailable"]')).toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-snippet"]')).toBeNull();
  });

  it("offers a Copy button alongside the snippet in the succeeded state", () => {
    const { el, socket } = mountWizard(baseDevice([{ name: "cala" }]));
    clickGo(el);
    emitLine(socket, "CALA:apply diffDrive.setConfigValue(ConfigField.RotationalSlip, 0.96)");
    const copyButton = el.querySelector<HTMLButtonElement>('[data-testid="rotation-calibration-copy"]');
    expect(copyButton).not.toBeNull();
    expect(() => act(() => copyButton!.click())).not.toThrow();
  });

  it("starts a fresh run on a second Go press, with no stale stages or snippet from the first run", () => {
    const { el, socket } = mountWizard(baseDevice([{ name: "cala" }]));
    clickGo(el);
    emitLine(socket, "CALA:pass clockwise");
    emitLine(socket, "CALA:apply diffDrive.setConfigValue(ConfigField.RotationalSlip, 0.9)");

    expect(el.querySelector('[data-testid="rotation-calibration-snippet"]')!.textContent).toBe(
      "diffDrive.setConfigValue(ConfigField.RotationalSlip, 0.9)",
    );

    socket.sent.length = 0;
    clickGo(el);
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", endpointId: "usb-ROBOT-A", verb: "RUN", fields: ["cala"] }),
    ]);
    // The stale snippet from the first run is gone; the new run has no
    // events yet since nothing has streamed in for it.
    expect(el.querySelector('[data-testid="rotation-calibration-result"]')).toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-stage-cw"]')).toBeNull();
    expect(el.querySelector<HTMLButtonElement>('[data-testid="rotation-calibration-go"]')!.disabled).toBe(true);

    emitLine(socket, "CALA:pass clockwise");
    emitLine(socket, "CALA:edge 1 at 89deg");
    const cwStage = el.querySelector('[data-testid="rotation-calibration-stage-cw"]')!;
    expect(cwStage.textContent).toContain("edge 1 at 89deg");
  });

  it("tolerates the endpoint's log being cleared mid-run (e.g. DeviceConsole's Clear log button) without throwing or showing stale progress", () => {
    const { el, socket } = mountWizardWithClear(baseDevice([{ name: "cala" }]));
    clickGo(el);
    emitLine(socket, "CALA:pass clockwise");
    emitLine(socket, "CALA:edge 1 at 90deg");
    expect(el.querySelector('[data-testid="rotation-calibration-stage-cw"]')).not.toBeNull();

    expect(() => {
      act(() => {
        el.querySelector<HTMLButtonElement>('[data-testid="test-clear-log"]')!.click();
      });
    }).not.toThrow();

    // The run's phase is derived fresh from the (now-empty) log slice --
    // no stale stage/event survives the clear, and the panel falls back
    // to a plain running state rather than crashing.
    expect(el.querySelector('[data-testid="rotation-calibration-stage-cw"]')).toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-result"]')).toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-failed"]')).toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-run-error"]')).toBeNull();
  });
});

describe("RotationCalibrationWizard regression: no nudge/beam-pointer UI", () => {
  it("never renders a nudge control or beam-pointer affordance in any state", () => {
    const { el, socket } = mountWizard(baseDevice([{ name: "cala" }]));
    expect(el.textContent).not.toMatch(/nudge/i);
    expect(el.textContent).not.toMatch(/beam/i);

    clickGo(el);
    emitLine(socket, "CALA:pass clockwise");
    expect(el.textContent).not.toMatch(/nudge/i);
    expect(el.textContent).not.toMatch(/beam/i);

    emitLine(socket, "CALA:apply diffDrive.setConfigValue(ConfigField.RotationalSlip, 0.96)");
    expect(el.textContent).not.toMatch(/nudge/i);
    expect(el.textContent).not.toMatch(/beam/i);
  });
});

describe("deriveRotationCalibrationRun (pure derivation)", () => {
  it("tolerates a log slice shorter than the recorded runStartIndex (e.g. a cleared log) without throwing, falling back to an empty running state", () => {
    // Mirrors DistanceCalibrationWizard's own doc-comment property: the
    // run's phase is derived fresh from whatever slice of the log is
    // handed in, never accumulated as separate state, so a shorter
    // slice than expected (a cleared log) is just an empty run, not an
    // error.
    expect(deriveRotationCalibrationRun([])).toEqual({ kind: "running", leadingEvents: [], stages: [] });
  });

  it("buckets progress lines under the most recently announced stage, in order", () => {
    const run = deriveRotationCalibrationRun([
      { direction: "rx", line: "CALA:begin track=11.5cm slip=0.952 b=12.08cm" },
      { direction: "rx", line: "CALA:pass clockwise" },
      { direction: "rx", line: "CALA:edge 1 at 92deg" },
      { direction: "rx", line: "CALA:pass counter-clockwise" },
      { direction: "rx", line: "CALA:edge 1 at 358deg" },
    ]);
    expect(run).toEqual({
      kind: "running",
      leadingEvents: ["begin track=11.5cm slip=0.952 b=12.08cm"],
      stages: [
        { stage: "cw", events: ["edge 1 at 92deg"] },
        { stage: "ccw", events: ["edge 1 at 358deg"] },
      ],
    });
  });
});
