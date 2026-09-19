/**
 * CalibrationStorePanel.tsx — the on-board calibration store panel
 * (`calshow`/`calclear`, profile `calibration-0.20260919.4`; background:
 * `clasi/issues/calibration-calj-calc-one-click.md`).
 *
 * ## The use case this panel exists for
 *
 * "A student runs both calibrations from the robot's own A/B button
 * menu with no computer attached, carries the robot to a laptop, plugs
 * in, and opens the calibrate menu to find their numbers and the code
 * that sets them." Every other panel on this tab (the two wizards, the
 * generated-code block) is driven by *this browser's own session state*
 * -- a wizard run made right here, right now. That is exactly the thing
 * the use case above has none of. This panel is the one place on the
 * page whose only input is the robot's own on-board answer to `calshow`,
 * asked automatically the moment a usable link opens, so the page is
 * useful about work this browser never watched happen.
 *
 * ## `has_wheel`/`has_turn` are the authority, never a zero
 *
 * `calstore.values`' `wheel`/`tw`/`slip` fields report `0` when nothing
 * was ever stored -- this panel never treats that zero as "the
 * calibration is zero"; it always branches on `hasWheel`/`hasTurn`
 * first, and shows an explicit "not calibrated yet" state when false.
 * The two calibrations are independent and are always rendered that
 * way -- a student who ran only one sees exactly that, never a default
 * standing in for the other.
 *
 * ## `runs === 1` must read differently from `runs === 4`
 *
 * A single `calwheels`/`calturn` run is not a precise estimate (sd
 * 0.16%-0.43% measured on `vevov`'s hardware, up to 1.2% between
 * extremes) -- see `clasi/issues/calibration-calj-calc-one-click.md`'s
 * successor notes and this ticket's own background. `calstore.runs`
 * exists specifically so this panel can draw a student's eye to "one
 * sample" rather than "a settled fact": a `*Runs === 1` calibration
 * gets its own visibly distinct callout (`calibration-store-runs-single`)
 * naming the known spread and suggesting another run, while
 * `*Runs >= 2` gets a plain, unremarkable "N runs, range ..." line.
 *
 * ## `calclear` is confirmed, never silent, and says what it clears
 *
 * Irreversible without a reflash -- see this component's own two-step
 * arm/confirm state (`confirming`), the same "no bare `window.confirm`"
 * discipline `FlashDialog.tsx`'s own doc comment already established
 * for this codebase (a blocking native dialog buys nothing a clearly
 * visible in-page confirmation doesn't already give, and the in-page
 * version can say exactly what's about to be lost). The confirmation
 * copy names both the geometry *and* the run statistics it clears,
 * since the run counts/spread are exactly the safety mechanism the
 * stakeholder built to make "keep the last run, not a mean" safe --
 * losing them silently would undermine that.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { calibToDiameterMm } from "../lib/calibration";
import { deriveCalStoreState } from "./CalibrationStore";
import { isLinkUsable } from "../deviceDisplay";
import { useLinkLog, useSendable, useWsActions } from "../ws/WsProvider";
import "./CalibrationStorePanel.css";

export interface CalibrationStorePanelProps {
  link: SnapshotLink;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

interface RunsSummaryProps {
  testId: string;
  runs: number | undefined;
  mean: number | undefined;
  lo: number | undefined;
  hi: number | undefined;
  spreadPct: number | undefined;
  unit: string;
}

/** Renders `calstore.runs`' per-calibration slice -- the piece that
 * makes `runs === 1` visibly different from `runs === 4`. `runs`
 * undefined or `0` renders nothing (no runs behind the stored value to
 * report, e.g. `calshow` hasn't sent `.runs` yet). */
function RunsSummary({ testId, runs, mean, lo, hi, spreadPct, unit }: RunsSummaryProps) {
  if (runs === undefined || runs <= 0) {
    return null;
  }
  if (runs === 1) {
    return (
      <p className="calibration-store-runs calibration-store-runs-single" data-testid={testId} role="status">
        Only <strong>1 run</strong> behind this — a single run typically varies by roughly 1% from the next one.
        {mean !== undefined ? ` (this run: ${mean} ${unit})` : ""} Run it again to see it settle.
      </p>
    );
  }
  const range = lo !== undefined && hi !== undefined ? ` (range ${lo}–${hi} ${unit}${spreadPct !== undefined ? `, ${spreadPct}% spread` : ""})` : "";
  return (
    <p className="calibration-store-runs calibration-store-runs-settled" data-testid={testId}>
      {runs} runs behind this{range}.
    </p>
  );
}

export function CalibrationStorePanel({ link }: CalibrationStorePanelProps) {
  const linkId = link.id;
  const sendable = useSendable();
  const linkOpen = isLinkUsable(link) && sendable;
  const { sendCommand } = useWsActions();
  const log = useLinkLog(linkId);

  const store = useMemo(() => deriveCalStoreState(log), [log]);

  // Send `calshow` once per usable-link streak -- this panel's entire
  // reason to exist is answering "what does the robot already have"
  // the instant it's plugged in, not waiting on a wizard run that, per
  // this ticket's use case, may never happen in this browser at all.
  const askedRef = useRef(false);
  useEffect(() => {
    if (!linkOpen) {
      askedRef.current = false;
      return;
    }
    if (!askedRef.current) {
      askedRef.current = true;
      sendCommand(linkId, "RUN", ["calshow"]);
    }
  }, [linkOpen, linkId, sendCommand]);

  function refresh(): void {
    if (!linkOpen) {
      return;
    }
    sendCommand(linkId, "RUN", ["calshow"]);
  }

  const [confirming, setConfirming] = useState(false);
  function requestClear(): void {
    setConfirming(true);
  }
  function cancelClear(): void {
    setConfirming(false);
  }
  function confirmClear(): void {
    setConfirming(false);
    sendCommand(linkId, "RUN", ["calclear"]);
  }

  const values = store.values;
  const runs = store.runs;
  // The boot-line hint is opportunistic and only worth showing before
  // any real `calshow` response has arrived this session -- once
  // `values` is set (even to "nothing stored"), it supersedes the hint
  // outright, per this module's own doc comment.
  const hint = values === undefined ? store.bootHint : undefined;

  const wheelKnown = values !== undefined;
  const wheelHas = values?.hasWheel ?? false;
  const wheelDiameterMm = values && wheelHas ? calibToDiameterMm(values.wheelCalib) : undefined;

  const turnKnown = values !== undefined;
  const turnHas = values?.hasTurn ?? false;

  return (
    <section className="calibration-store-panel" aria-label="Robot's stored calibration" data-testid="calibration-store-panel">
      <div className="calibration-store-header">
        <h4>Robot's stored calibration</h4>
        <button
          type="button"
          className="calibration-store-refresh"
          data-testid="calibration-store-refresh"
          disabled={!linkOpen}
          onClick={refresh}
        >
          Refresh
        </button>
      </div>

      {!linkOpen && (
        <p className="calibration-store-hint" data-testid="calibration-store-idle" role="status">
          Not connected — open a link to this robot to read what it has stored.
        </p>
      )}

      {linkOpen && values === undefined && store.justCleared && (
        <p className="calibration-store-cleared" data-testid="calibration-store-cleared" role="status">
          Cleared. The robot no longer has either calibration stored, and its run statistics are gone too.
        </p>
      )}

      {linkOpen && values === undefined && !store.justCleared && (
        <p className="calibration-store-hint" data-testid="calibration-store-waiting" role="status">
          {hint
            ? hint.none
              ? "Waiting to confirm with the robot — at last boot it had neither calibration stored."
              : "Waiting to confirm with the robot — this is what it reported at last boot, unconfirmed this session."
            : "Asking the robot what it has stored…"}
        </p>
      )}

      <div className="calibration-store-row" data-testid="calibration-store-wheel">
        <h5>Wheel calibration</h5>
        {wheelKnown ? (
          wheelHas ? (
            <>
              <p className="calibration-store-value" data-testid="calibration-store-wheel-value">
                Wheel diameter: <strong>{wheelDiameterMm} mm</strong> — stored on the robot, survives a power cycle.
              </p>
              {/* `wheel`/`wheel_mean`/`wheel_lo`/`wheel_hi` are all in
                  **mm per shaft degree**, not millimetres of diameter.
                  Rendering them with a bare "mm" next to the diameter
                  headline above put "90.02 mm" and "range 0.78-0.7896 mm"
                  on adjacent lines -- two different quantities wearing the
                  same unit, which reads as nonsense. Converted to
                  diameters so the range is directly comparable to the
                  headline it sits under. The spread percentage is
                  scale-invariant and needs no conversion. */}
              <RunsSummary
                testId="calibration-store-wheel-runs"
                runs={runs?.wheelRuns}
                mean={runs?.wheelMean !== undefined ? calibToDiameterMm(runs.wheelMean) : undefined}
                lo={runs?.wheelLo !== undefined ? calibToDiameterMm(runs.wheelLo) : undefined}
                hi={runs?.wheelHi !== undefined ? calibToDiameterMm(runs.wheelHi) : undefined}
                spreadPct={runs?.wheelSpreadPct}
                unit="mm"
              />
            </>
          ) : (
            <p className="calibration-store-missing" data-testid="calibration-store-wheel-missing">
              Not calibrated yet — running the wheel calibration replaces the firmware's compiled default.
            </p>
          )
        ) : (
          hint && !hint.none && hint.wheelCalib !== undefined && (
            <p className="calibration-store-value calibration-store-value-hint" data-testid="calibration-store-wheel-hint">
              At last boot: wheel diameter <strong>{calibToDiameterMm(hint.wheelCalib)} mm</strong> (unconfirmed this session).
            </p>
          )
        )}
      </div>

      <div className="calibration-store-row" data-testid="calibration-store-turn">
        <h5>Rotation calibration</h5>
        {turnKnown ? (
          turnHas ? (
            <>
              <p className="calibration-store-value" data-testid="calibration-store-turn-value">
                Track width <strong>{values!.trackWidthCm} cm</strong>, slip <strong>{values!.slip}</strong> — stored
                on the robot, survives a power cycle.
              </p>
              <RunsSummary
                testId="calibration-store-turn-runs"
                runs={runs?.turnRuns}
                mean={runs?.turnMean !== undefined ? round2(runs.turnMean) : undefined}
                lo={runs?.turnLo}
                hi={runs?.turnHi}
                spreadPct={runs?.turnSpreadPct}
                unit="cm"
              />
            </>
          ) : (
            <p className="calibration-store-missing" data-testid="calibration-store-turn-missing">
              Not calibrated yet — running the rotation calibration replaces the firmware's compiled default.
            </p>
          )
        ) : (
          hint &&
          !hint.none &&
          hint.trackWidthCm !== undefined && (
            <p className="calibration-store-value calibration-store-value-hint" data-testid="calibration-store-turn-hint">
              At last boot: track width <strong>{hint.trackWidthCm} cm</strong>
              {hint.slip !== undefined ? (
                <>
                  , slip <strong>{hint.slip}</strong>
                </>
              ) : (
                ""
              )}{" "}
              (unconfirmed this session).
            </p>
          )
        )}
      </div>

      <div className="calibration-store-clear">
        {!confirming ? (
          <button
            type="button"
            className="calibration-store-clear-button"
            data-testid="calibration-store-clear"
            disabled={!linkOpen}
            onClick={requestClear}
          >
            Clear stored calibration
          </button>
        ) : (
          <div className="calibration-store-clear-confirm" data-testid="calibration-store-clear-confirm" role="alertdialog">
            <p>
              This clears <strong>both</strong> stored calibrations and their run statistics — irreversible without a
              reflash. The student who most needs this is the one who just calibrated against the wrong course
              length, and without it the only way back is a reflash.
            </p>
            <button
              type="button"
              className="calibration-store-clear-confirm-yes"
              data-testid="calibration-store-clear-confirm-yes"
              onClick={confirmClear}
            >
              Yes, clear it
            </button>
            <button
              type="button"
              className="calibration-store-clear-cancel"
              data-testid="calibration-store-clear-cancel"
              onClick={cancelClear}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
