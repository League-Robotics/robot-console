/**
 * CalibrationTable.tsx — the "current calibration" two-column table
 * (wheel diameter / measured track width / effective track width /
 * rotational slip), shared by `CalibrationPage`'s own Calibration tab
 * and `ConfigurationPage`'s Configuration tab (ticket 017-008;
 * `docs/reviews/2026-09-11/04-ui.md` §4's "Calibration table" row).
 *
 * The two call sites' markup and copy are almost, but not quite,
 * identical (`CalibrationPage.tsx`'s and `ConfigurationPage.tsx`'s own
 * pre-extraction versions): only `CalibrationPage` shows the "from
 * distance calibration" / "wheel centre to wheel centre" annotations,
 * and the two pages phrase the not-yet-measured effective-track and
 * unmeasured-slip cells differently. `variant` reproduces each site's
 * exact prior text/DOM (ids, `data-testid`s, and copy) rather than
 * picking one -- a pure extraction, not a redesign, same discipline as
 * ticket 007's `RelayConnectControls` "card"/"page" variants.
 *
 * ## Ticket 018-013: "wheel track" vs "measured track width (robot-reported)"
 *
 * The stakeholder's own vocabulary ("wheel diameter, wheel track,
 * measured track width, effective track width, and rotational slip")
 * names two distinct track-width facts this table used to collapse
 * under one ambiguous label: the row that used to read "Measured track
 * width" is the student's own ruler measurement
 * (`CalibrationState.measuredTrackWidthCm`, always manually entered) --
 * renamed here to "Wheel track" to match the stakeholder's own term and
 * to free up "Measured track width" for the row this ticket adds: the
 * robot's own `calturn.result` `b` field (`CalibrationState.
 * reportedTrackWidthCm`, sourced from the rotation calibration, never
 * typed in) -- labelled "Measured track width (robot-reported)" so the
 * two are never confused again.
 *
 * ## OOP 2026-09-18: `tw` (boot-record track width) and `firmwareSlip`
 *
 * Two more robot-reported facts, added when `cala`/`calc` were replaced
 * by the current `calturn`: `robotTrackWidthCm` (`calturn.result`'s
 * `tw` field -- this robot's own track width, baked into its boot
 * record at flash time, shown with that provenance so it reads as a
 * record rather than a live measurement) and `firmwareSlip`
 * (`calturn.result`'s own `slip` field, the value the rotation wizard's
 * Apply button actually sends). `firmwareSlip` shows alongside this
 * table's own computed slip, replacing the retired `robotReportedSlip`
 * row annotation -- see `lib/calibration.ts`'s own doc comment for why
 * the two numbers are never merged into one.
 */
import { parsePositiveNumber, type CalibrationPatch, type CalibrationState, type DerivedCalibration } from "../lib/calibration";
import "./CalibrationTable.css";

export type CalibrationTableVariant = "calibration" | "configuration";

export interface CalibrationTableProps {
  variant: CalibrationTableVariant;
  state: CalibrationState;
  derived: DerivedCalibration;
  onPatch: (patch: CalibrationPatch) => void;
}

export function CalibrationTable({ variant, state, derived, onPatch }: CalibrationTableProps) {
  const idPrefix = variant;
  const tableTestId = variant === "calibration" ? "calibration-table" : "configuration-calibration";
  const effectiveTestId = `${variant}-effective-track`;
  const slipTestId = `${variant}-slip`;

  return (
    <table className="calibration-table" data-testid={tableTestId}>
      <tbody>
        <tr>
          <th scope="row">
            <label htmlFor={`${idPrefix}-wheel-diameter`}>Wheel diameter</label>
          </th>
          <td>
            <input
              id={`${idPrefix}-wheel-diameter`}
              type="number"
              inputMode="decimal"
              step="0.01"
              min="1"
              placeholder="not calibrated"
              value={state.wheelDiameterMm ?? ""}
              onChange={(event) => {
                const value = parsePositiveNumber(event.target.value);
                onPatch({ wheelDiameterMm: value, wheelDiameterSource: value === undefined ? undefined : "entered" });
              }}
            />{" "}
            mm
            {variant === "calibration" && state.wheelDiameterSource === "distance-calibration" && (
              <span className="calibration-source"> from distance calibration</span>
            )}
          </td>
        </tr>
        <tr>
          <th scope="row">
            <label htmlFor={`${idPrefix}-track-width`}>Measured track width</label>
          </th>
          <td>
            <input
              id={`${idPrefix}-track-width`}
              type="number"
              inputMode="decimal"
              step="0.01"
              min="1"
              placeholder="optional"
              value={state.measuredTrackWidthCm ?? ""}
              onChange={(event) => onPatch({ measuredTrackWidthCm: parsePositiveNumber(event.target.value) })}
            />{" "}
            cm
            {variant === "calibration" && (
              <span className="calibration-source"> wheel centre to wheel centre, measured with a caliper</span>
            )}
          </td>
        </tr>
        <tr>
          <th scope="row">Effective track width</th>
          <td data-testid={effectiveTestId}>
            {derived.effectiveTrackWidthCm !== undefined
              ? `${derived.effectiveTrackWidthCm} cm`
              : variant === "calibration"
                ? "not measured yet — run the turn calibration"
                : "run the turn calibration"}
            {variant === "calibration" && derived.effectiveTrackWidthCm !== undefined && (
              <span className="calibration-source"> what the spin measured, scaled to the wheel above</span>
            )}
          </td>
        </tr>
        <tr>
          <th scope="row">Rotational slip</th>
          <td data-testid={slipTestId}>
            {derived.effectiveTrackWidthCm === undefined
              ? variant === "calibration"
                ? "— needs the effective track width, so run the turn calibration"
                : "—"
              : state.measuredTrackWidthCm === undefined
                ? variant === "calibration"
                  ? "1 — no measured track width, so the effective width is used as the track"
                  : "1"
                : `${derived.rotationalSlip}`}
            {variant === "calibration" &&
              state.measuredTrackWidthCm !== undefined &&
              derived.effectiveTrackWidthCm !== undefined && (
                <span className="calibration-source">
                  {" "}
                  {state.measuredTrackWidthCm} ÷ {derived.effectiveTrackWidthCm}
                </span>
              )}
          </td>
        </tr>
      </tbody>
    </table>
  );
}
