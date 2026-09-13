/**
 * CalibrationPage.tsx — the robot page's Calibration tab (OOP
 * 2026-09-10, stakeholder direction; expanded ticket 018-013; corrected
 * 018-013, stakeholder 2026-09-13).
 *
 * One calibration *state* per robot (persisted per robot name in
 * localStorage), one block of code to paste, and the wizards/run
 * controls feeding that state. The state shape, its undefined-stripping
 * merge, and the derived-value/code-generation math moved to
 * `lib/calibration.ts` (ticket 017-008), shared with
 * `ConfigurationPage.tsx`; the "current calibration" table moved to
 * `components/CalibrationTable.tsx`, shared the same way. See that
 * module's own doc comment for the wheel-diameter/track-width/
 * effective-width/slip relationship this page's wizards feed.
 *
 * ## Ticket 018-013, corrected 2026-09-13: firmware flash lives here too,
 * FUNCS never hides a run
 *
 * `f1b0e8d` put this tab's original flash/run/console shape here under a
 * commit message that mis-cited it as ticket "018-010"; a same-day
 * follow-up pass then moved the flash panel to the Configuration tab.
 * The stakeholder's own correction reverses that move: "If we have a
 * Calibrate tab, then we don't need calibration under the Configuration
 * tab. You can just put it under Calibrate." The root cause of a
 * concrete failure this same pass diagnosed -- a robot with `cala`
 * genuinely registered on the firmware reading as CalX-only -- was a
 * dropped Wi-Fi burst line in `FUNCS`'s own reply, ack included, list
 * incomplete; the fix generalizes to a rule this tab now holds
 * everywhere: **`FUNCS` must never hide or block a calibration run.**
 *
 *  1. **`CalibrationFirmwarePanel`** (`./CalibrationFirmwarePanel.tsx`)
 *     mounts at the top of the left column -- the flash/verify block,
 *     unchanged in behavior, just relocated back here and reading
 *     `device` directly rather than through `ConfigurationPage`.
 *  2. **Both wizards always render**, no `FUNCS`-derived hide/show. A
 *     robot whose `FUNCS` reply is silent on `cala` (dropped over Wi-Fi,
 *     or never asked) still gets a Calibrate A button -- disabling or
 *     hiding it on absent evidence is exactly the failure mode that
 *     produced "only CalX" on a robot that has `cala` right there in its
 *     firmware. Each wizard shows its own non-blocking hint instead (see
 *     `DistanceCalibrationWizard.tsx`/`RotationCalibrationWizard.tsx`).
 *     `FUNCS` is still requested once, on mount, if the session has no
 *     function list yet -- not to gate the two wizards any more, but so
 *     any *other* `cal*` name it lists still gets its own
 *     `GenericCalibrationRun` control below them.
 *  3. **No filtered console on this tab.** `CalibrationConsole.tsx` (a
 *     second, calibration-only view of the same link's log) is retired
 *     outright -- the right column's full, unfiltered `DeviceConsole`
 *     already shows every line, calibration traffic included, and a
 *     second filtered view of the same log added confusion (which
 *     console has the line?) without adding information.
 *  4. **`robotReportedSlip`** (`RotationCalibrationWizard.tsx`'s own
 *     `CALA:derived slip=...` reader) still updates
 *     `CalibrationState.robotReportedSlip`, shown alongside this page's
 *     own computed `rotationalSlip` in `CalibrationTable.tsx` -- see that
 *     module's own doc comment for why the two numbers are never merged.
 */
import { useEffect, useMemo, useState } from "react";
import type { RobotFunction, SnapshotDevice, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import {
  CALIBRATION_IMAGE_BASELINE_DIAMETER_MM,
  applyCalibrationPatch,
  calibrationCode,
  deriveCalibration,
  readCalibrationState,
  writeCalibrationState,
  type CalibrationPatch,
  type CalibrationState,
} from "../lib/calibration";
import { useCopied } from "../lib/clipboard";
import { isLinkUsable } from "../deviceDisplay";
import { useSendable, useWsActions } from "../ws/WsProvider";
import { CalibrationFirmwarePanel } from "./CalibrationFirmwarePanel";
import { CalibrationTable } from "./CalibrationTable";
import { DeviceConsole } from "./DeviceConsole";
import {
  DistanceCalibrationWizard,
  deriveBaselineDiameterMm,
  deriveWheelDiameterMm,
  type DistanceCalibrationRun,
} from "./DistanceCalibrationWizard";
import {
  RotationCalibrationWizard,
  reportedTrackWidthCm,
  robotReportedSlip,
  type RotationCalibrationRun,
} from "./RotationCalibrationWizard";
import "./CalibrationPage.css";

export interface CalibrationPageProps {
  link: SnapshotLink;
  /** The owning device's already-resolved name -- see `RobotPage.tsx`'s
   * doc comment ("Sprint 015 ticket 009") for why the caller resolves
   * both `link` and `name` rather than this page re-deriving them from
   * a retired flat endpoint shape. */
  name: string;
  /** The owning device snapshot -- stakeholder correction 2026-09-13:
   * `CalibrationFirmwarePanel` needs `device.program`/`device.version`/
   * `device.links` for the flash/verify block now mounted here. */
  device: SnapshotDevice;
}

/** `calx`/`cala` get their stakeholder-specified labels verbatim; any
 * other `cal*` name `FUNCS` reports is labelled from its own suffix --
 * ticket 018-013's own required truth: "do not guess a third verb". */
export function calibrationFunctionLabel(name: string): string {
  if (name === "calx") {
    return "Calibrate X (distance)";
  }
  if (name === "cala") {
    return "Calibrate A (rotation)";
  }
  return `Calibrate ${name.slice(3)}`;
}

interface GenericCalibrationRunProps {
  link: SnapshotLink;
  name: string;
}

/** A run control for a `cal*` function this page has no dedicated wizard
 * for -- one button, gated exactly like `FunctionsPanel.tsx`'s own Go
 * button (`isLinkUsable` + `useSendable`), dispatching a bare
 * `RUN <name>` with no arguments. Its output (any `<NAME_PREFIX>:` lines
 * the firmware emits, plus the RUN's own ack/err) shows up in
 * `CalibrationConsole` below, not inline here -- this control's only job
 * is to send the run. */
function GenericCalibrationRun({ link, name }: GenericCalibrationRunProps) {
  const sendable = useSendable();
  const linkOpen = isLinkUsable(link) && sendable;
  const { sendCommand } = useWsActions();
  const label = calibrationFunctionLabel(name);

  return (
    <div className="robot-page-panel calibration-generic-run" aria-label={label}>
      <h3>{label}</h3>
      <button
        type="button"
        className="calibration-generic-run-go"
        data-testid={`calibration-run-${name}`}
        disabled={!linkOpen}
        onClick={() => sendCommand(link.id, "RUN", [name])}
      >
        Run
      </button>
      {!linkOpen && (
        <p className="calibration-generic-run-hint" data-testid={`calibration-run-${name}-hint`} role="status">
          Open a link to this robot to run {name}.
        </p>
      )}
    </div>
  );
}

export function CalibrationPage({ link, name, device }: CalibrationPageProps) {
  const robotName = name;
  const [state, setState] = useState<CalibrationState>(() => readCalibrationState(robotName));
  useEffect(() => {
    writeCalibrationState(robotName, state);
  }, [robotName, state]);

  const derived = useMemo(() => deriveCalibration(state), [state]);
  const code = useMemo(() => calibrationCode(state, robotName), [state, robotName]);
  const { copied, copy } = useCopied();

  const sendable = useSendable();
  const linkOpen = isLinkUsable(link) && sendable;
  const { sendCommand } = useWsActions();
  const functions: RobotFunction[] | undefined = link.session?.functions ?? undefined;
  const functionsUnknown = functions === undefined;

  // Ticket 018-013: this tab specifically needs the function list before
  // it can decide which run controls to draw, so (unlike every other
  // panel `RobotPage` mounts since sprint 015 ticket 009) it asks once,
  // on open, if nothing has asked yet this session.
  useEffect(() => {
    if (functionsUnknown && linkOpen) {
      sendCommand(link.id, "FUNCS");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires again only when "do we have a list yet" flips, or the link/openness identity changes
  }, [link.id, linkOpen, functionsUnknown]);

  // Stakeholder correction (2026-09-13): `FUNCS` must never hide or
  // block a calibration run -- both wizards below always render,
  // regardless of what this list does or doesn't contain (a dropped
  // Wi-Fi burst line can make a genuinely-registered `cala` vanish from
  // the ack'd reply). This list only ever adds a control now, never
  // removes one: any *other* `cal*` name it reports gets its own
  // `GenericCalibrationRun` below the two dedicated wizards.
  const calFunctionNames = useMemo(() => (functions ?? []).map((fn) => fn.name).filter((n) => n.startsWith("cal")), [functions]);
  const extraCalFunctionNames = calFunctionNames.filter((n) => n !== "calx" && n !== "cala");

  function update(patch: CalibrationPatch): void {
    setState((previous) => applyCalibrationPatch(previous, patch));
  }

  function handleDistanceRun(run: DistanceCalibrationRun | undefined): void {
    if (run?.kind !== "succeeded") {
      return;
    }
    const diameter = deriveWheelDiameterMm(run.events, run.snippet);
    if (diameter === undefined) {
      return;
    }
    update({ wheelDiameterMm: diameter, wheelDiameterSource: "distance-calibration" });
    // A rotation result made with an older diameter is now stale.
    const baseline = deriveBaselineDiameterMm(run.events);
    if (baseline !== undefined && state.reportedWithDiameterMm === undefined) {
      update({ reportedWithDiameterMm: baseline });
    }
  }

  function handleRotationRun(run: RotationCalibrationRun | undefined): void {
    if (run?.kind === "succeeded") {
      const reported = reportedTrackWidthCm(run);
      if (reported !== undefined) {
        update({ reportedTrackWidthCm: reported, reportedWithDiameterMm: CALIBRATION_IMAGE_BASELINE_DIAMETER_MM });
      }
      const slip = robotReportedSlip(run);
      if (slip !== undefined) {
        update({ robotReportedSlip: slip });
      }
      return;
    }
    if (run?.kind === "failed") {
      // A failed re-verification must not leave a width or slip standing.
      update({ reportedTrackWidthCm: undefined, robotReportedSlip: undefined });
    }
  }

  const rotationBlocked = state.wheelDiameterMm === undefined;

  return (
    <div className="robot-page-columns calibration-page" data-testid="robot-tab-panel-calibration">
      <div className="robot-page-column robot-page-column-left">
        <CalibrationFirmwarePanel device={device} link={link} />

        <div className="robot-page-panel" aria-label="Distance calibration">
          <h3>{calibrationFunctionLabel("calx")}</h3>
          <DistanceCalibrationWizard link={link} onRun={handleDistanceRun} />
        </div>

        <div className="robot-page-panel" aria-label="Rotation calibration">
          <h3>{calibrationFunctionLabel("cala")}</h3>
          <RotationCalibrationWizard
            link={link}
            onRun={handleRotationRun}
            disabled={rotationBlocked}
            disabledReason="Run the distance calibration first — the rotation run needs the wheel diameter."
          />
        </div>

        {extraCalFunctionNames.map((fnName) => (
          <GenericCalibrationRun key={fnName} link={link} name={fnName} />
        ))}

        <div className="robot-page-panel calibration-code-panel" aria-label="Calibration code">
          <h3>Code for your program</h3>
          {code === "" ? (
            <p className="calibration-code-empty" data-testid="calibration-code-empty">
              Nothing to paste yet — run the distance calibration to get started.
            </p>
          ) : (
            <>
              <pre className="calibration-code" data-testid="calibration-code">
                {code}
              </pre>
              <button
                type="button"
                className="calibration-code-copy"
                data-testid="calibration-code-copy"
                onClick={() => copy(code)}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="robot-page-column robot-page-column-right">
        <div className="robot-page-panel" aria-label="Current calibration">
          <h3>Current calibration</h3>
          <CalibrationTable variant="calibration" state={state} derived={derived} onPatch={update} />
          <button
            type="button"
            className="calibration-reset"
            data-testid="calibration-reset"
            onClick={() => setState({})}
            disabled={Object.keys(state).length === 0}
          >
            Start over
          </button>
        </div>

        <DeviceConsole link={link} name={robotName} />
      </div>
    </div>
  );
}
