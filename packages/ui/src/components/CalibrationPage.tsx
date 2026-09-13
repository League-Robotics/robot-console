/**
 * CalibrationPage.tsx — the robot page's Calibration tab (OOP
 * 2026-09-10, stakeholder direction).
 *
 * One calibration *state* per robot (persisted per robot name in
 * localStorage), one block of code to paste, and the two wizards
 * feeding that state. The state shape, its undefined-stripping merge,
 * and the derived-value/code-generation math moved to
 * `lib/calibration.ts` (ticket 017-008), shared with
 * `ConfigurationPage.tsx`; the "current calibration" table moved to
 * `components/CalibrationTable.tsx`, shared the same way. See that
 * module's own doc comment for the wheel-diameter/track-width/
 * effective-width/slip relationship this page's wizards feed.
 */
import { useEffect, useMemo, useState } from "react";
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
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
import { CalibrationTable } from "./CalibrationTable";
import { DeviceConsole } from "./DeviceConsole";
import {
  DistanceCalibrationWizard,
  deriveBaselineDiameterMm,
  deriveWheelDiameterMm,
  type DistanceCalibrationRun,
} from "./DistanceCalibrationWizard";
import { RotationCalibrationWizard, reportedTrackWidthCm, type RotationCalibrationRun } from "./RotationCalibrationWizard";
import "./CalibrationPage.css";

export interface CalibrationPageProps {
  link: SnapshotLink;
  /** The owning device's already-resolved name -- see `RobotPage.tsx`'s
   * doc comment ("Sprint 015 ticket 009") for why the caller resolves
   * both `link` and `name` rather than this page re-deriving them from
   * a retired flat endpoint shape. */
  name: string;
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
      return;
    }
    if (run?.kind === "failed") {
      // A failed re-verification must not leave a width standing.
      update({ reportedTrackWidthCm: undefined });
    }
  }

  const rotationBlocked = state.wheelDiameterMm === undefined;

  return (
    <div className="robot-page-columns calibration-page" data-testid="robot-tab-panel-calibration">
      <div className="robot-page-column robot-page-column-left">
        <div className="robot-page-panel" aria-label="Distance calibration">
          <h3>Distance calibration</h3>
          <DistanceCalibrationWizard link={link} onRun={handleDistanceRun} />
        </div>

        <div className="robot-page-panel" aria-label="Rotation calibration">
          <h3>Rotation calibration</h3>
          <RotationCalibrationWizard
            link={link}
            onRun={handleRotationRun}
            disabled={rotationBlocked}
            disabledReason="Run the distance calibration first — the rotation run needs the wheel diameter."
          />
        </div>

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
