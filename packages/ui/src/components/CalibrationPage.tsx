/**
 * CalibrationPage.tsx — the robot page's Calibration tab (OOP
 * 2026-09-10, stakeholder direction; expanded ticket 018-013).
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
 * ## Ticket 018-013: always offered, dynamic run buttons + a filtered
 * console -- the flash panel moved to the Configuration tab
 *
 * `f1b0e8d` added this tab's original flash/run/console shape under a
 * commit message and doc comments that mis-cited it as ticket "018-010"
 * (an unrelated, concurrently in-progress ticket, UI truthfulness for
 * link-status text) -- this section, and the feature itself, actually
 * belong to ticket 018-013. Three changes remain over the OOP 2026-09-10
 * shape (a fourth, the "Calibration firmware" panel, moved out entirely
 * -- see below):
 *
 *  1. **This tab is now always offered for a robot** (`RobotPage.tsx` no
 *     longer gates it on `isCalibrationProgram(device.program)`) -- a
 *     robot not yet running the calibration build can still reach this
 *     tab to run `calx`/`cala` once it does. Flashing itself -- and the
 *     "what's actually running" text -- moved to `ConfigurationPage.tsx`
 *     (ticket 018-013, per the stakeholder's explicit placement: "put
 *     this as a flash button under the calibration section in the
 *     Configuration tab"); see that module's own doc comment.
 *  2. **Run controls are derived from `FUNCS`, not hardcoded to exactly
 *     two.** `calx`/`cala` still render as the existing
 *     `DistanceCalibrationWizard`/`RotationCalibrationWizard` (unchanged
 *     internally -- this page does not re-dispatch their own `RUN`s),
 *     but only while the session's function list is still unknown
 *     (`functions === undefined`, so each wizard's own "checking..."
 *     hint still shows) or the robot's own `FUNCS` reply actually lists
 *     that name -- once the list is known and a given name is absent,
 *     no button, no "unavailable" message, nothing (silence, not a
 *     hardcoded assumption of a third verb). Any other `cal*` name
 *     `FUNCS` lists gets a small generic run control
 *     (`GenericCalibrationRun` below) this page did not have before.
 *     `FUNCS` is requested once, on mount, if the session has no
 *     function list yet -- a deliberate exception to sprint 015 ticket
 *     009's "panels don't self-probe" rule, since this tab specifically
 *     needs the list before it can decide which buttons to draw, unlike
 *     the wizards it embeds (which always rendered regardless of
 *     whether anything had ever asked).
 *  3. **`CalibrationConsole`** (`./CalibrationConsole.tsx`) sits directly
 *     under the code block -- a second, filtered view of this same
 *     link's log (not a second connection), showing only the
 *     calibration program's own traffic. The right column's full,
 *     unfiltered `DeviceConsole` is unchanged and still present for
 *     anyone who wants the raw wire.
 *  4. **New parsed state**: `RotationCalibrationWizard.tsx`'s own
 *     `robotReportedSlip` (the firmware's own `CALA:derived slip=...`
 *     line) now also updates `CalibrationState.robotReportedSlip`,
 *     shown alongside this page's own computed `rotationalSlip` in
 *     `CalibrationTable.tsx` -- see that module's own doc comment for
 *     why the two numbers are never merged.
 */
import { useEffect, useMemo, useState } from "react";
import type { RobotFunction, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
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
import { CalibrationConsole } from "./CalibrationConsole";
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

export function CalibrationPage({ link, name }: CalibrationPageProps) {
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

  const calFunctionNames = useMemo(() => (functions ?? []).map((fn) => fn.name).filter((n) => n.startsWith("cal")), [functions]);
  const extraCalFunctionNames = calFunctionNames.filter((n) => n !== "calx" && n !== "cala");
  const showDistanceWizard = functionsUnknown || calFunctionNames.includes("calx");
  const showRotationWizard = functionsUnknown || calFunctionNames.includes("cala");
  const noCalFunctions = !functionsUnknown && calFunctionNames.length === 0;

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
        {functionsUnknown && (
          <p className="calibration-functions-hint" data-testid="calibration-functions-checking" role="status">
            Checking which calibration functions this robot supports…
          </p>
        )}

        {noCalFunctions && (
          <p className="calibration-functions-hint" data-testid="calibration-no-functions" role="status">
            This robot's firmware doesn't report any calibration functions.
          </p>
        )}

        {showDistanceWizard && (
          <div className="robot-page-panel" aria-label="Distance calibration">
            <h3>{calibrationFunctionLabel("calx")}</h3>
            <DistanceCalibrationWizard link={link} onRun={handleDistanceRun} />
          </div>
        )}

        {showRotationWizard && (
          <div className="robot-page-panel" aria-label="Rotation calibration">
            <h3>{calibrationFunctionLabel("cala")}</h3>
            <RotationCalibrationWizard
              link={link}
              onRun={handleRotationRun}
              disabled={rotationBlocked}
              disabledReason="Run the distance calibration first — the rotation run needs the wheel diameter."
            />
          </div>
        )}

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

        <div className="robot-page-panel calibration-console-panel">
          <CalibrationConsole link={link} />
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
