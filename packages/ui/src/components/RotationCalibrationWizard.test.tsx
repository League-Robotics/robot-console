// @vitest-environment jsdom
/**
 * RotationCalibrationWizard.test.tsx — component tests for ticket 004's
 * rotation-calibration wizard (SUC-004; migrated to the `Snapshot`
 * contract and its on-open probe removed, sprint 015 ticket 009).
 *
 * Mirrors `DistanceCalibrationWizard.test.tsx`'s structure exactly: the
 * `cala`-gated availability split into two distinct "not asked yet" /
 * "answered without cala" messages, the black-tape-cross setup
 * instructions (no beam pointer, no nudging), the `RUN cala` dispatch on
 * Go, progressive rendering of `CALA:` lines as four distinct pass
 * stages (not collapsed into one spinner), the terminal `apply` line
 * rendered verbatim as the snippet, a `CALA:fail` line's distinct
 * failure state (at various stages, not just the first), a `RUN` `err
 * 1` reply's own distinct state, a second run after a completed one, and
 * the regression check that no nudge/beam-pointer UI ever appears in
 * this panel.
 *
 * Ticket 009 deletes the "fires a one-shot FUNCS probe on mount" pinned
 * test case this file used to carry, not adapting it -- see
 * `DistanceCalibrationWizard.test.tsx`'s identical note.
 *
 * **`apply` is not the last line on the wire.** `test/calibratea.ts`
 * emits `CALA:apply ...` and then immediately re-runs both directions a
 * second time to verify the fix -- `CALA:check clockwise`/`CALA:check
 * counter-clockwise` and their own progress lines arrive AFTER `apply`,
 * not before it. The fixtures below use that real order, and separately
 * cover a `CALA:fail` arriving *after* `apply` -- the run must flip to
 * `failed` and drop the snippet, since a failed re-verification must
 * never leave a green result standing.
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
import type { RobotFunction, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { RotationCalibrationWizard, deriveRotationCalibrationRun, reportedTrackWidthCm, robotReportedSlip } from "./RotationCalibrationWizard";
import { WsProvider, useWsActions } from "../ws/WsProvider";
import { FakeSocket } from "../testing/FakeSocket";

/** A minimal stand-in for `DeviceConsole`'s own "Clear log" button --
 * mounted alongside the wizard under the same `WsProvider` so a click
 * here exercises the exact `clearLinkLog` action a real "Clear log"
 * press would fire, without pulling in the whole console. */
function ClearLogButton({ linkId }: { linkId: string }) {
  const { clearLinkLog } = useWsActions();
  return (
    <button type="button" data-testid="test-clear-log" onClick={() => clearLinkLog(linkId)}>
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
      <RotationCalibrationWizard link={link} />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket! };
}

function mountWizardWithClear(link: SnapshotLink): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <RotationCalibrationWizard link={link} />
      <ClearLogButton linkId={link.id} />
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
    socket.emitMessage({ type: "line", linkId: LINK_ID, direction: "rx", line });
  });
}

describe("RotationCalibrationWizard availability", () => {
  it("stakeholder 2026-09-13: before any FUNCS reply the Calibrate A button is present and enabled (an unanswered FUNCS never blocks the run)", () => {
    const { el } = mountWizard(linkWithFunctions(undefined));
    expect(el.querySelector('[data-testid="rotation-calibration-idle"]')).toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-unavailable"]')).toBeNull();
    const go = el.querySelector<HTMLButtonElement>('[data-testid="rotation-calibration-go"]')!;
    expect(go.textContent).toBe("Calibrate A");
    expect(go.disabled).toBe(false);
  });

  it("shows the non-alarming unavailable message and keeps Go disabled when FUNCS answers without cala", () => {
    const { el } = mountWizard(linkWithFunctions([{ name: "calx" }, { name: "abort" }]));
    const hint = el.querySelector('[data-testid="rotation-calibration-unavailable"]');
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toContain("doesn't support calibration yet");
    expect(el.querySelector('[data-testid="rotation-calibration-idle"]')).toBeNull();
    expect(el.querySelector<HTMLButtonElement>('[data-testid="rotation-calibration-go"]')!.disabled).toBe(true);
    expect(el.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("shows the black-tape-cross setup instructions and enables Go once cala is present", () => {
    const { el } = mountWizard(linkWithFunctions([{ name: "calx" }, { name: "cala" }]));
    const setup = el.querySelector('[data-testid="rotation-calibration-setup"]');
    expect(setup).not.toBeNull();
    expect(setup!.textContent).toContain("black tape");
    expect(setup!.textContent).toContain("cross");
    expect(el.querySelector<HTMLButtonElement>('[data-testid="rotation-calibration-go"]')!.disabled).toBe(false);
  });

  it("disables Go when there is no open session even with cala available", () => {
    const { el } = mountWizard(closedLink());
    expect(el.querySelector<HTMLButtonElement>('[data-testid="rotation-calibration-go"]')!.disabled).toBe(true);
  });
});

describe("RotationCalibrationWizard run dispatch", () => {
  it("sends RUN cala via sendCommand when Go is pressed", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "cala" }]));
    socket.sent.length = 0;
    clickGo(el);
    expect(socket.sent).toEqual([JSON.stringify({ type: "send-command", linkId: LINK_ID, verb: "RUN", fields: ["cala"] })]);
  });

  it("hides the setup instructions and disables Go once a run is in flight", () => {
    const { el } = mountWizard(linkWithFunctions([{ name: "cala" }]));
    clickGo(el);
    expect(el.querySelector('[data-testid="rotation-calibration-setup"]')).toBeNull();
    expect(el.querySelector<HTMLButtonElement>('[data-testid="rotation-calibration-go"]')!.disabled).toBe(true);
  });
});

describe("RotationCalibrationWizard progress rendering", () => {
  it("renders the CW pass, CCW pass, and the firmware's own re-verification passes as distinct, visibly separate stages -- not collapsed into one spinner", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "cala" }]));
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
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "cala" }]));
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
  it("renders a CALA:apply line's exact text as the snippet, byte-for-byte after stripping only 'CALA:apply ', in the firmware's own real emission order (cw, ccw, apply, then the two re-verification passes)", () => {
    // test/calibratea.ts emits `CALA:apply ...` once the correction is
    // computed -- *before* it re-runs both directions a second time to
    // verify the fix -- so `CALA:check clockwise`/`CALA:check
    // counter-clockwise` and their own progress lines arrive AFTER
    // apply, not before it. The panel must still be "succeeded" as soon
    // as apply is seen, and must still populate/render the two
    // re-verification stages as they stream in afterward.
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "cala" }]));
    clickGo(el);
    emitLine(socket, "CALA:begin track=11.5cm slip=0.952 b=12.08cm");
    emitLine(socket, "CALA:pass clockwise");
    emitLine(socket, "CALA:edge 1 at 92deg");
    emitLine(socket, "CALA:centring scatter=4.2deg");
    emitLine(socket, "CALA:pass counter-clockwise");
    emitLine(socket, "CALA:edge 1 at 358deg");
    emitLine(socket, "CALA:centring scatter=3.9deg");
    emitLine(socket, "CALA:apply diffDrive.setConfigValue(ConfigField.RotationalSlip, 0.965)");

    let snippet = el.querySelector('[data-testid="rotation-calibration-snippet"]')!;
    expect(snippet.textContent).toBe("diffDrive.setConfigValue(ConfigField.RotationalSlip, 0.965)");
    expect(el.querySelector('[data-testid="rotation-calibration-failed"]')).toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-run-error"]')).toBeNull();
    // Go re-enables so the student can run again if they want to.
    expect(el.querySelector<HTMLButtonElement>('[data-testid="rotation-calibration-go"]')!.disabled).toBe(false);
    // The two earlier stages are already visible alongside the result.
    expect(el.querySelector('[data-testid="rotation-calibration-stage-cw"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-stage-ccw"]')).not.toBeNull();
    // The re-verification stages haven't been announced yet -- not
    // fabricated ahead of the firmware's own marker lines.
    expect(el.querySelector('[data-testid="rotation-calibration-stage-check-cw"]')).toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-stage-check-ccw"]')).toBeNull();

    // The firmware keeps talking after apply -- its own re-verification
    // passes stream in next, and must still render even though the run
    // is already succeeded.
    emitLine(socket, "CALA:check clockwise");
    emitLine(socket, "CALA:edge 1 at 90.5deg");
    emitLine(socket, "CALA:check counter-clockwise");
    emitLine(socket, "CALA:edge 1 at 269.7deg");
    emitLine(socket, "CALA:error cw=0.4deg ccw=-0.2deg per turn");

    const checkCw = el.querySelector('[data-testid="rotation-calibration-stage-check-cw"]')!;
    expect(checkCw).not.toBeNull();
    expect(checkCw.textContent).toContain("edge 1 at 90.5deg");
    const checkCcw = el.querySelector('[data-testid="rotation-calibration-stage-check-ccw"]')!;
    expect(checkCcw).not.toBeNull();
    expect(checkCcw.textContent).toContain("edge 1 at 269.7deg");
    expect(checkCcw.textContent).toContain("error cw=0.4deg ccw=-0.2deg per turn");

    // The snippet and Go's re-enabled state are unaffected by the
    // re-verification lines still streaming in afterward.
    snippet = el.querySelector('[data-testid="rotation-calibration-snippet"]')!;
    expect(snippet.textContent).toBe("diffDrive.setConfigValue(ConfigField.RotationalSlip, 0.965)");
    expect(el.querySelector('[data-testid="rotation-calibration-failed"]')).toBeNull();
  });

  it("flips a succeeded run to failed if a CALA:fail line arrives after CALA:apply -- a failed re-verification must not leave a green result standing", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "cala" }]));
    clickGo(el);
    emitLine(socket, "CALA:pass clockwise");
    emitLine(socket, "CALA:edge 1 at 90deg");
    emitLine(socket, "CALA:pass counter-clockwise");
    emitLine(socket, "CALA:edge 1 at 270deg");
    emitLine(socket, "CALA:apply diffDrive.setConfigValue(ConfigField.RotationalSlip, 0.965)");

    expect(el.querySelector('[data-testid="rotation-calibration-result"]')).not.toBeNull();

    emitLine(socket, "CALA:check clockwise");
    emitLine(socket, "CALA:fail STALLED, power-cycle the robot");

    const failed = el.querySelector('[data-testid="rotation-calibration-failed"]')!;
    expect(failed).not.toBeNull();
    expect(failed.textContent).toContain("STALLED, power-cycle the robot");
    // The earlier "succeeded" result is gone -- no green result and no
    // snippet stand alongside a failed re-verification.
    expect(el.querySelector('[data-testid="rotation-calibration-result"]')).toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-snippet"]')).toBeNull();
  });

  it("renders a distinct failure state on a CALA:fail line during the very first pass, never a snippet", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "cala" }]));
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
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "cala" }]));
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
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "cala" }]));
    clickGo(el);
    emitLine(socket, "err 1 #1");

    const runError = el.querySelector('[data-testid="rotation-calibration-run-error"]')!;
    expect(runError).not.toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-failed"]')).toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-unavailable"]')).toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-snippet"]')).toBeNull();
  });

  it("starts a fresh run on a second Go press, with no stale stages or snippet from the first run", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "cala" }]));
    clickGo(el);
    emitLine(socket, "CALA:pass clockwise");
    emitLine(socket, "CALA:apply diffDrive.setConfigValue(ConfigField.RotationalSlip, 0.9)");

    expect(el.querySelector('[data-testid="rotation-calibration-snippet"]')!.textContent).toBe(
      "diffDrive.setConfigValue(ConfigField.RotationalSlip, 0.9)",
    );

    socket.sent.length = 0;
    clickGo(el);
    expect(socket.sent).toEqual([JSON.stringify({ type: "send-command", linkId: LINK_ID, verb: "RUN", fields: ["cala"] })]);
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

  it("tolerates the link's log being cleared mid-run (e.g. DeviceConsole's Clear log button) without throwing or showing stale progress", () => {
    const { el, socket } = mountWizardWithClear(linkWithFunctions([{ name: "cala" }]));
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

describe("RotationCalibrationWizard with the apply line dropped over WiFi (OOP 2026-09-10)", () => {
  it("reconstructs the snippet from CALA:derived when CALA:apply and the check marker never arrive (live gopiv capture)", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "cala" }]));
    clickGo(el);
    for (const line of [
      "CALA:begin track=11.5cm slip=0.952 b=12.08cm",
      "CALA:pass clockwise",
      "CALA:armed at 2.8deg",
      "CALA:centring scatter=21.1deg  HIGH -- b reads low, re-centre",
      "CALA:pass counter-clockwise",
      "CALA:centring scatter=11.3deg",
      "CALA:slope cw=0.7693 ccw=0.6945 gap=26.9deg/turn",
      "CALA:measured b=8.84cm  (anchor was 12.08)",
      "CALA:derived slip=1.301 = track 11.5 / b 8.84",
      // apply + "check clockwise" dropped by the WiFi module here
      "CALA:armed at 4deg",
    ]) {
      emitLine(socket, line);
    }
    expect(el.querySelector('[data-testid="rotation-calibration-snippet"]')?.textContent).toBe(
      "diffDrive.setConfigValue(ConfigField.RotationalSlip, 1.301)",
    );
    // A later fail during the check still overrides it.
    emitLine(socket, "CALA:fail gap 148deg before 270 -- missed an arm, re-centre the robot");
    expect(el.querySelector('[data-testid="rotation-calibration-snippet"]')).toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-failed"]')?.textContent).toContain("re-centre the robot");
  });

  it("prefers the real apply line when it does arrive", () => {
    expect(
      deriveRotationCalibrationRun([
        { direction: "rx", line: "CALA:derived slip=1.301 = track 11.5 / b 8.84" },
        { direction: "rx", line: "CALA:apply diffDrive.setConfigValue(ConfigField.RotationalSlip, 1.302)" },
      ]),
    ).toMatchObject({ kind: "succeeded", snippet: "diffDrive.setConfigValue(ConfigField.RotationalSlip, 1.302)" });
  });
});

describe("RotationCalibrationWizard in a long-lived tab (OOP 2026-09-10 regression)", () => {
  it("still reaches the result when the log ring was already full at Go and keeps filling during the run", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "cala" }]));
    // A tab open for hours: the ring is at capacity before Go.
    act(() => {
      for (let i = 0; i < 520; i += 1) {
        socket.emitMessage({ type: "line", linkId: LINK_ID, direction: "rx", line: `status ready=1 cyc=${i}` });
      }
    });
    clickGo(el);
    emitLine(socket, "CALA:begin track=11.5cm slip=0.952 b=12.08cm");
    emitLine(socket, "CALA:pass clockwise");
    emitLine(socket, "CALA:pass counter-clockwise");
    emitLine(socket, "CALA:apply diffDrive.setConfigValue(ConfigField.RotationalSlip, 0.957)");
    emitLine(socket, "CALA:check clockwise");
    // Plenty more traffic after the apply line -- enough to push every
    // run line out of an index-based window.
    act(() => {
      for (let i = 0; i < 600; i += 1) {
        socket.emitMessage({ type: "line", linkId: LINK_ID, direction: "rx", line: `status ready=1 cyc=${1000 + i}` });
      }
    });
    emitLine(socket, "CALA:check counter-clockwise");
    emitLine(socket, "CALA:error cw=0.1deg ccw=-0.2deg per turn");

    const snippet = el.querySelector('[data-testid="rotation-calibration-snippet"]');
    expect(snippet).not.toBeNull();
    expect(snippet!.textContent).toBe("diffDrive.setConfigValue(ConfigField.RotationalSlip, 0.957)");
  });
});

describe("RotationCalibrationWizard regression: no nudge/beam-pointer UI", () => {
  it("never renders a nudge control or beam-pointer affordance in any state", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "cala" }]));
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

  it("keeps consuming entries after CALA:apply so the two re-verification stages -- which the real firmware announces after apply, not before -- still populate", () => {
    const run = deriveRotationCalibrationRun([
      { direction: "rx", line: "CALA:pass clockwise" },
      { direction: "rx", line: "CALA:edge 1 at 92deg" },
      { direction: "rx", line: "CALA:pass counter-clockwise" },
      { direction: "rx", line: "CALA:edge 1 at 358deg" },
      { direction: "rx", line: "CALA:apply diffDrive.setConfigValue(ConfigField.RotationalSlip, 0.965)" },
      { direction: "rx", line: "CALA:check clockwise" },
      { direction: "rx", line: "CALA:edge 1 at 90.5deg" },
      { direction: "rx", line: "CALA:check counter-clockwise" },
      { direction: "rx", line: "CALA:edge 1 at 269.7deg" },
    ]);
    expect(run).toEqual({
      kind: "succeeded",
      snippet: "diffDrive.setConfigValue(ConfigField.RotationalSlip, 0.965)",
      leadingEvents: [],
      stages: [
        { stage: "cw", events: ["edge 1 at 92deg"] },
        { stage: "ccw", events: ["edge 1 at 358deg"] },
        { stage: "check-cw", events: ["edge 1 at 90.5deg"] },
        { stage: "check-ccw", events: ["edge 1 at 269.7deg"] },
      ],
    });
  });

  it("overrides a recorded apply snippet with failed if CALA:fail arrives afterward", () => {
    const run = deriveRotationCalibrationRun([
      { direction: "rx", line: "CALA:apply diffDrive.setConfigValue(ConfigField.RotationalSlip, 0.965)" },
      { direction: "rx", line: "CALA:check clockwise" },
      { direction: "rx", line: "CALA:fail STALLED, power-cycle the robot" },
    ]);
    expect(run).toEqual({ kind: "failed", reason: "STALLED, power-cycle the robot" });
  });
});

describe("RotationCalibrationWizard as CalibrationPage drives it (OOP 2026-09-10)", () => {
  it("is blocked, with the reason shown and Go disabled, until the page says a wheel diameter is known", () => {
    let socket: FakeSocket | null = null;
    const el = mount(
      <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
        <RotationCalibrationWizard link={linkWithFunctions([{ name: "cala" }])} disabled disabledReason="Run the distance calibration first." />
      </WsProvider>,
    );
    act(() => {
      socket!.emitOpen();
    });
    expect(el.querySelector('[data-testid="rotation-calibration-blocked"]')?.textContent).toBe("Run the distance calibration first.");
    expect(el.querySelector<HTMLButtonElement>('[data-testid="rotation-calibration-go"]')!.disabled).toBe(true);
    expect(el.querySelector('[data-testid="rotation-calibration-setup"]')).toBeNull();
  });

  it("reports the run to onRun and exposes the robot's measured track width", () => {
    const runs: string[] = [];
    let socket: FakeSocket | null = null;
    const el = mount(
      <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
        <RotationCalibrationWizard link={linkWithFunctions([{ name: "cala" }])} onRun={(run) => runs.push(run ? run.kind : "none")} />
      </WsProvider>,
    );
    act(() => {
      socket!.emitOpen();
    });
    clickGo(el);
    emitLine(socket!, "CALA:begin track=11.5cm slip=0.952 b=12.08cm");
    emitLine(socket!, "CALA:pass clockwise");
    emitLine(socket!, "CALA:measured b=8.84cm  (anchor was 12.08)");
    emitLine(socket!, "CALA:apply diffDrive.setConfigValue(ConfigField.RotationalSlip, 1.301)");
    expect(el.querySelector('[data-testid="rotation-calibration-track"]')?.textContent).toContain("8.84 cm");
    expect(runs.at(-1)).toBe("succeeded");
    expect(
      reportedTrackWidthCm(
        deriveRotationCalibrationRun([{ direction: "rx", line: "CALA:measured b=8.84cm  (anchor was 12.08)" }]),
      ),
    ).toBe(8.84);
  });

  it("ticket 018-013: robotReportedSlip reads the firmware's own CALA:derived slip= line, distinct from reportedTrackWidthCm", () => {
    const run = deriveRotationCalibrationRun([
      { direction: "rx", line: "CALA:measured b=8.84cm  (anchor was 12.08)" },
      { direction: "rx", line: "CALA:derived slip=1.301 = track 11.5 / b 8.84" },
    ]);
    expect(robotReportedSlip(run)).toBe(1.301);
    expect(reportedTrackWidthCm(run)).toBe(8.84);
    // Absent entirely (no `derived slip=` line yet) reads `undefined`, not 0.
    expect(
      robotReportedSlip(deriveRotationCalibrationRun([{ direction: "rx", line: "CALA:measured b=8.84cm" }])),
    ).toBeUndefined();
  });
});
