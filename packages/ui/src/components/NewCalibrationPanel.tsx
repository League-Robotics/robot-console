/**
 * NewCalibrationPanel.tsx — the guided calibration run (stakeholder
 * direction, 2026-09-19), replacing the two standalone wizard panels.
 *
 * ## The flow, and why it is a gate and not three buttons
 *
 *   Start  ->  Calibrate Wheels  ->  Calibrate Turns  ->  Done
 *
 * A turn result is only meaningful against the wheel that was on the
 * robot when the spin happened: `calturn` measures `b` by driving the
 * wheels, so every b is denominated in the current wheel. Re-running
 * the wheel calibration therefore invalidates the turn, and this panel
 * enforces that literally -- a new wheel run discards the turn records
 * and takes the Done button away until a turn has been run again.
 * Nothing else in this console was stopping somebody from pairing a
 * fresh diameter with yesterday's slip.
 *
 * Wheels may be run as many times as you like before moving on; the
 * records accumulate and the mean is what gets written. Turns likewise.
 *
 * ## What Done writes
 *
 * The averaged wheel diameter, the track width and the slip, through
 * `lib/calibrationWrite.ts` -- the `SET`s for immediate effect and
 * `RUN calsave` so they survive the power cycle. After that the
 * per-run records are dropped: they were only ever there to be
 * averaged, and the robot is now the record.
 *
 * ## Standard deviation, not percent spread
 *
 * See `lib/calibration.ts`'s `stdDev`. One run shows no spread figure
 * at all rather than 0.00, because one run has no spread -- which is
 * not the same as a spread of zero.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { useLinkLog, useSendable, useWsActions } from "../ws/WsProvider";
import { isLinkUsable } from "../deviceDisplay";
import {
  CALIBRATION_IMAGE_BASELINE_DIAMETER_MM,
  deriveCalibration,
  mean,
  parsePositiveNumber,
  round,
  stdDev,
  type CalibrationPatch,
  type CalibrationState,
} from "../lib/calibration";
import { buildCalibrationWrites, describeCalibrationWrites, writeCalibration } from "../lib/calibrationWrite";
import "./NewCalibrationPanel.css";
import {
  deriveTurnCalibrationRun,
  deriveWheelsCalibrationRun,
  type TurnCalibrationRun,
  type WheelsCalibrationRun,
} from "../lib/calibrationRun";

/** The firmware's own declared default for `calwheels (cm:number=90.5)`. */
const DEFAULT_TAPE_CM = "90.5";

/** `calturn (edges:number=10)`. Fixed: the firmware rounds whatever it
 * is given to the nearest valid 8n+2 anyway, and 10 is the only value
 * anybody used -- so it is no longer a control (stakeholder, 2026-09-19). */
const TURN_EDGES = "10";

/** A finished wheel run worth keeping: the diameter it measured. */
interface WheelRecord {
  diameterMm: number;
  /** The wheel-calibration constant the robot was running during the
   * run, as a diameter. The NEXT turn run's `b` is denominated in the
   * last one of these, not in the mean -- see `reportedWithDiameterMm`
   * below. */
  ranWithMm: number;
}

interface TurnRecord {
  /** `calturn.result`'s own `b`, uncorrected. */
  bCm: number;
  /** The firmware's own slip (`tw / b`) -- its baked track-width record
   * divided by what it just measured. Kept for the record; the slip the
   * table shows comes from the caliper width when there is one. */
  firmwareSlip: number;
}

export interface NewCalibrationPanelProps {
  link: SnapshotLink;
  state: CalibrationState;
  onPatch: (patch: CalibrationPatch) => void;
  /** Asked to re-read the robot's stored calibration after a run. */
  onStoreChanged?: (() => void) | undefined;
}

type Pending = { kind: "wheels" | "turns"; startId: number };

export function NewCalibrationPanel({ link, state, onPatch, onStoreChanged }: NewCalibrationPanelProps) {
  const linkId = link.id;
  const sendable = useSendable();
  const linkOpen = isLinkUsable(link) && sendable;
  const { sendCommand } = useWsActions();
  const log = useLinkLog(linkId);

  const [started, setStarted] = useState(false);
  const [wheelRecords, setWheelRecords] = useState<WheelRecord[]>([]);
  const [turnRecords, setTurnRecords] = useState<TurnRecord[]>([]);
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  const [tapeText, setTapeText] = useState(DEFAULT_TAPE_CM);
  const [writtenNote, setWrittenNote] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const tapeCm = parsePositiveNumber(tapeText);

  // The run's window is anchored on the log entry *id* minted at the
  // click, not an array index -- a bounded log ring trimmed from the
  // front would otherwise slide an index-based window out from under a
  // long-lived tab. (Same reasoning as the wizards this replaces.)
  const run = useMemo<WheelsCalibrationRun | TurnCalibrationRun | undefined>(() => {
    if (!pending) return undefined;
    const slice = log.filter((entry) => entry.id >= pending.startId);
    return pending.kind === "wheels" ? deriveWheelsCalibrationRun(slice) : deriveTurnCalibrationRun(slice);
  }, [log, pending]);

  const running = run?.kind === "running";

  // A terminal run is folded into the records exactly once. Keyed on
  // the pending window's own startId so a re-render cannot double-count
  // a run, which would quietly bias the mean.
  const settledRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!pending || !run || run.kind === "running") return;
    if (settledRef.current === pending.startId) return;
    settledRef.current = pending.startId;

    if (pending.kind === "wheels") {
      const wheels = run as WheelsCalibrationRun;
      if (wheels.kind === "succeeded") {
        const diameterMm = round(wheels.result.diameterMm, 2);
        const ranWithMm = round((wheels.result.wasCalib * 360) / Math.PI, 2);
        setWheelRecords((previous) => [...previous, { diameterMm, ranWithMm }]);
        // A new wheel invalidates every turn measured against the old
        // one -- the whole reason this panel gates the flow.
        setTurnRecords([]);
        setFailure(undefined);
      } else {
        setFailure(describeFailure("wheel", wheels));
      }
    } else {
      const turn = run as TurnCalibrationRun;
      if (turn.kind === "succeeded") {
        setTurnRecords((previous) => [...previous, { bCm: turn.result.b, firmwareSlip: turn.result.slip }]);
        setFailure(undefined);
      } else {
        setFailure(describeFailure("turn", turn));
      }
    }
    setPending(undefined);
    onStoreChanged?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- folds once per settled window
  }, [run, pending]);

  // The averages feed the Current calibration table as they accumulate,
  // so the table always shows what Done would write.
  const wheelMean = useMemo(() => mean(wheelRecords.map((record) => record.diameterMm)), [wheelRecords]);
  const wheelSd = useMemo(() => stdDev(wheelRecords.map((record) => record.diameterMm)), [wheelRecords]);
  const bMean = useMemo(() => mean(turnRecords.map((record) => record.bCm)), [turnRecords]);
  const slipSd = useMemo(() => stdDev(turnRecords.map((record) => record.firmwareSlip)), [turnRecords]);

  const patchRef = useRef(onPatch);
  patchRef.current = onPatch;
  useEffect(() => {
    if (wheelMean === undefined) return;
    patchRef.current({ wheelDiameterMm: round(wheelMean, 2), wheelDiameterSource: "distance-calibration" });
  }, [wheelMean]);
  useEffect(() => {
    if (bMean === undefined) {
      patchRef.current({ reportedTrackWidthCm: undefined, firmwareSlip: undefined });
      return;
    }
    // `b` is denominated in the wheel the robot was RUNNING for the
    // spin -- the last wheel run's own result, which `calwheels` stored
    // on the robot as it finished -- not in the mean this console is
    // about to write. Getting this wrong rescales the track width by
    // the difference between the two.
    const lastRan = wheelRecords.length > 0 ? wheelRecords[wheelRecords.length - 1]!.diameterMm : undefined;
    patchRef.current({
      reportedTrackWidthCm: round(bMean, 3),
      reportedWithDiameterMm: lastRan ?? state.reportedWithDiameterMm ?? CALIBRATION_IMAGE_BASELINE_DIAMETER_MM,
      firmwareSlip: mean(turnRecords.map((record) => record.firmwareSlip)),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- driven by the records, not by `state`
  }, [bMean, wheelRecords]);

  const hasWheels = wheelRecords.length > 0;
  const hasTurns = turnRecords.length > 0;

  // EXACTLY ONE BUTTON IS BLUE: the one to press next (stakeholder,
  // 2026-09-19). The flow already decides which buttons exist; this
  // decides which of them is the call to action, so the accent moves
  // down the panel as the run progresses rather than sitting on Start
  // forever. Re-running wheels sends it back to "turns", which is the
  // same invalidation the Done button's disappearance shows.
  const nextStep: "start" | "wheels" | "turns" | "done" = !started
    ? "start"
    : !hasWheels
      ? "wheels"
      : !hasTurns
        ? "turns"
        : "done";
  const accent = (step: typeof nextStep): string => (step === nextStep ? "new-calibration-next" : "");

  function begin(kind: "wheels" | "turns"): void {
    if (!linkOpen || running) return;
    const last = log[log.length - 1];
    setWrittenNote(undefined);
    setPending({ kind, startId: last ? last.id + 1 : 0 });
    if (kind === "wheels") {
      if (tapeCm === undefined) return;
      // 0 is the firmware's own "unknown wheel" sentinel, and unknown is
      // the honest answer: a robot being calibrated is a robot whose
      // wheel is in question.
      sendCommand(linkId, "RUN", ["calwheels", String(tapeCm), "0"]);
    } else {
      sendCommand(linkId, "RUN", ["calturn", TURN_EDGES]);
    }
  }

  function handleStart(): void {
    setStarted(true);
    setWheelRecords([]);
    setTurnRecords([]);
    setPending(undefined);
    setFailure(undefined);
    setWrittenNote(undefined);
    settledRef.current = undefined;
  }

  function handleDone(): void {
    const derived = deriveCalibration(state);
    const writes = buildCalibrationWrites(state, derived);
    if (writes.length === 0 || !linkOpen) return;
    writeCalibration(sendCommand, linkId, writes);
    setWrittenNote(`Written to the robot — ${describeCalibrationWrites(writes)}.`);
    // The per-run records existed to be averaged and have been. What
    // survives is the calibration itself, on the robot and in the table.
    setWheelRecords([]);
    setTurnRecords([]);
    setStarted(false);
    onStoreChanged?.();
  }

  return (
    <div className="robot-page-panel new-calibration" aria-label="New calibration">
      <h3>New calibration</h3>

      {!started && (
        <button
          type="button"
          className={`new-calibration-start ${accent("start")}`}
          data-testid="new-calibration-start"
          disabled={!linkOpen}
          onClick={handleStart}
        >
          Start
        </button>
      )}

      {started && (
        <>
          <div className="new-calibration-step">
            <label htmlFor="new-calibration-tape">Tape-measured line-to-line distance</label>{" "}
            <input
              id="new-calibration-tape"
              type="number"
              inputMode="decimal"
              step="0.1"
              min="1"
              value={tapeText}
              onChange={(event) => setTapeText(event.target.value)}
            />{" "}
            cm
          </div>

          <div className="new-calibration-step">
            <button
              type="button"
              className={accent("wheels")}
              data-testid="new-calibration-wheels"
              disabled={!linkOpen || running || tapeCm === undefined}
              onClick={() => begin("wheels")}
            >
              Calibrate wheels
            </button>
            {hasWheels && (
              <span className="new-calibration-stat" data-testid="new-calibration-wheel-stat">
                {wheelRecords.length} {wheelRecords.length === 1 ? "run" : "runs"} · mean{" "}
                {round(wheelMean!, 2)} mm{wheelSd !== undefined ? ` · sd ${round(wheelSd, 3)} mm` : ""}
              </span>
            )}
          </div>

          {hasWheels && (
            <div className="new-calibration-step">
              <button
                type="button"
                className={accent("turns")}
                data-testid="new-calibration-turns"
                disabled={!linkOpen || running}
                onClick={() => begin("turns")}
              >
                Calibrate turns
              </button>
              {hasTurns && (
                <span className="new-calibration-stat" data-testid="new-calibration-turn-stat">
                  {turnRecords.length} {turnRecords.length === 1 ? "run" : "runs"} · mean b {round(bMean!, 2)} cm
                  {slipSd !== undefined ? ` · slip sd ${round(slipSd, 4)}` : ""}
                </span>
              )}
            </div>
          )}

          {hasWheels && hasTurns && (
            <div className="new-calibration-step">
              <button
                type="button"
                className={`new-calibration-done ${accent("done")}`}
                data-testid="new-calibration-done"
                disabled={!linkOpen || running}
                onClick={handleDone}
              >
                Done
              </button>
              <span className="new-calibration-stat">writes the averages to the robot</span>
            </div>
          )}

          {running && (
            <p className="new-calibration-running" role="status" data-testid="new-calibration-running">
              Running {pending?.kind === "wheels" ? "the wheel calibration" : "the turn calibration"}…
            </p>
          )}
        </>
      )}

      {failure && (
        <p className="new-calibration-failure" role="status" data-testid="new-calibration-failure">
          {failure}
        </p>
      )}
      {writtenNote && (
        <p className="new-calibration-written" role="status" data-testid="new-calibration-written">
          {writtenNote}
        </p>
      )}
    </div>
  );
}

/** One line a student can act on, for every non-success terminal state.
 * The wizards this replaces rendered these at length; the detail is
 * still in the console on the left, which is where a run's own lines
 * land. */
function describeFailure(which: "wheel" | "turn", run: WheelsCalibrationRun | TurnCalibrationRun): string {
  const label = which === "wheel" ? "wheel calibration" : "turn calibration";
  if (run.kind === "failed") {
    const implied = "implied" in run && run.implied !== undefined ? ` (the run implies a ${run.implied} mm wheel)` : "";
    return `The ${label} failed: ${run.why}${implied}. Nothing was recorded.`;
  }
  if (run.kind === "run-error") {
    return `The robot refused to run the ${label} — it may be running an older program. Nothing was recorded.`;
  }
  if (run.kind === "unreadable") {
    return `The ${label} answered, but the reply could not be read. Nothing was recorded.`;
  }
  return `The ${label} did not finish. Nothing was recorded.`;
}
