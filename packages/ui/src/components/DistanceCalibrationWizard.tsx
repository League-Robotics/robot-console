/**
 * DistanceCalibrationWizard.tsx — the wheel-travel-calibration
 * (`calwheels`) wizard panel, mounted on `RobotPage` (ticket 003,
 * SUC-003; rewritten OOP 2026-09-18 for current firmware).
 *
 * ## OOP 2026-09-18: `calx` -> `calwheels`, prose -> JSON lines
 *
 * Per `clasi/issues/calibration-calj-calc-one-click.md`, `calx` (and its
 * one-hop successor `calj`) is gone; the surviving verb is `calwheels
 * (cm:number=90.5)`, and its reports are JSON lines
 * (`{"ev":"calwheels.result", ...}` / `.quality` / `.span` / `.fail`),
 * not `CALX:`-prefixed prose. This panel's structure is otherwise
 * unchanged from ticket 003's original design:
 *
 *  - **Availability, `FUNCS`-gated, not classification-gated**: Go is
 *    enabled regardless of what `FUNCS` says (a dropped Wi-Fi burst
 *    line must never hide or block a run, stakeholder 2026-09-13); an
 *    absent `calwheels` in a *known* function list only earns a
 *    non-blocking hint.
 *  - **Running**, `RUN calwheels <cm>` dispatched via `sendCommand`,
 *    where `cm` is the tape-measured line-to-line distance the operator
 *    typed in (default `90.5`, the firmware's own declared default) --
 *    per the issue, this is "the one length the whole wheel calibration
 *    scales by", so it is editable and never silently defaulted at Go
 *    time.
 *  - **Progress**, derived from the link's own rx log via
 *    `CalibrationReport.parseCalibrationLine`. Every JSON line this
 *    module doesn't specifically recognize (`.quality`, `.span`, an
 *    unrelated verb's own lines) is rendered as one generic progress
 *    line via `formatCalibrationEvent`, or silently ignored if it
 *    belongs to a different verb entirely (`parsed.verb !== VERB`).
 *  - **A run ends in exactly one of `.result`/`.fail`** (never assumed
 *    otherwise) or a bare `err ...` reply to the `RUN` command itself
 *    (a missing/wrong program name) -- three distinct terminal states,
 *    never confused with each other. A `.result` line whose fields
 *    don't validate (missing/non-numeric) is its own fourth terminal
 *    state, "unreadable" -- a malformed report must never be shown as a
 *    confident number.
 *  - **The run's own log window is derived, not accumulated**:
 *    `runStartId` records the next log entry id at Go, and the run's
 *    phase is recomputed from `log.filter(id >= runStartId)` on every
 *    render.
 *
 * ## No Apply control -- ever
 *
 * Measured on hardware (the issue's own table): `travel_calib` returns
 * `err 1` over `SET` -- there is no such config field. `calwheels`'s
 * result cannot be applied live at all; it needs a full rebuild and
 * reflash. This panel shows the measured diameter and the line to paste
 * into a rebuilt program, and nothing else -- no disabled button, no
 * button that would error if pressed. A control that cannot work must
 * not exist (see `RotationCalibrationWizard.tsx`'s own doc comment for
 * the contrasting case: `calturn`'s result genuinely can be applied).
 *
 * No nudge control, no beam-pointer UI: this routine has neither (see
 * `sprint.md`'s Detail-planning findings, unchanged since ticket 003).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { formatCalibrationEvent, parseCalibrationLine, parseWheelsResult, type WheelsResult } from "./CalibrationReport";
import { parsePositiveNumber } from "../lib/calibration";
import { useLinkLog, useSendable, useWsActions } from "../ws/WsProvider";
import { isLinkUsable } from "../deviceDisplay";
import "./DistanceCalibrationWizard.css";

/** Matches a bare `err ...` reply to the `RUN` command itself (e.g.
 * `err 1 #7`, `wire_handler.cpp`'s convention for an unregistered
 * program name) -- never a `calwheels.*` JSON line, since those are
 * intercepted by {@link parseCalibrationLine} first. Loose prefix
 * match, mirroring `CommandStrip.tsx`'s own `GET_REPLY_PATTERN`
 * discipline rather than a fixed reply grammar. */
const RUN_ERR_REPLY_PATTERN = /^err\b/i;

/** The wire verb this wizard runs. Isolated to this one constant --
 * per `CalibrationReport.ts`'s own doc comment, the shared parser knows
 * nothing about verb names at all, specifically so a fourth rename (two
 * have already happened in one day) touches only this line. */
const VERB = "calwheels";

/** The firmware's own declared default (`calwheels (cm:number=90.5)`). */
const DEFAULT_CM = "90.5";

/** One calibration run's current phase, derived from the endpoint's log
 * -- see this module's doc comment. */
export type WheelsCalibrationRun =
  | { kind: "running"; events: string[] }
  | { kind: "run-error"; events: string[] }
  | { kind: "unreadable"; events: string[] }
  | { kind: "failed"; events: string[]; why: string; implied?: number; lo?: number; hi?: number }
  | { kind: "succeeded"; events: string[]; result: WheelsResult };

/** Pure derivation of a run's phase from the slice of `log` recorded
 * since Go was pressed -- exported so `DistanceCalibrationWizard.test.tsx`
 * can exercise it directly against fixture log slices.
 *
 * Drop-tolerant by construction (issue's "Lines get dropped" section):
 * this loop never requires any particular event to have arrived --
 * `.quality`/`.span` lines, if present, are rendered as progress and
 * otherwise simply never appear; only `.result`/`.fail`/a bare `err`
 * reply end the run. A JSON line belonging to a different verb (e.g.
 * `calturn`'s own traffic on the same link, or an unrelated future
 * `cal*` routine) is tolerated silently, exactly like non-JSON noise.
 */
export function deriveWheelsCalibrationRun(
  entries: readonly { direction: "tx" | "rx"; line: string }[],
): WheelsCalibrationRun {
  let events: string[] = [];
  for (const entry of entries) {
    if (entry.direction !== "rx") {
      continue;
    }
    const parsed = parseCalibrationLine(entry.line);
    if (parsed) {
      if (parsed.verb !== VERB) {
        // Noise from a different routine's own JSON lines -- tolerated
        // silently, exactly like non-calibration noise.
        continue;
      }
      if (parsed.kind === "result") {
        const result = parseWheelsResult(parsed.fields);
        // A run that produced a `.result` line but whose fields don't
        // validate is not a success -- "couldn't read this run", never
        // a confident wrong diameter.
        return result ? { kind: "succeeded", events, result } : { kind: "unreadable", events };
      }
      if (parsed.kind === "fail") {
        // nezha-robot-template efa5a6f: a `calwheels.fail` now carries
        // `implied` -- the wheel diameter the run's own endpoints imply
        // -- plus the accepted span `lo`/`hi` in cm. That is the number
        // worth showing a student: a bad START detection once implied a
        // 778 mm wheel, which says "the field reading went wrong", not
        // "your robot is broken". Optional, and absent on older
        // firmware, so every field is read defensively.
        return {
          kind: "failed",
          events,
          why: parsed.why ?? "no reason given",
          ...(typeof parsed.fields.implied === "number" && Number.isFinite(parsed.fields.implied)
            ? { implied: parsed.fields.implied }
            : {}),
          ...(typeof parsed.fields.lo === "number" && Number.isFinite(parsed.fields.lo) ? { lo: parsed.fields.lo } : {}),
          ...(typeof parsed.fields.hi === "number" && Number.isFinite(parsed.fields.hi) ? { hi: parsed.fields.hi } : {}),
        };
      }
      events = [...events, formatCalibrationEvent(parsed.ev, parsed.fields)];
      continue;
    }
    if (RUN_ERR_REPLY_PATTERN.test(entry.line.trim())) {
      return { kind: "run-error", events };
    }
  }
  return { kind: "running", events };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The line a student pastes into a rebuilt program: the extension's
 * only geometry setter takes mm per shaft degree, so the diameter is
 * written literally and the conversion (π·D/360) is spelled out in the
 * code itself rather than hidden in a pre-multiplied constant. */
export function wheelDiameterSnippet(diameterMm: number): string {
  return `diffDrive.setWheelCalibration(${diameterMm} * Math.PI / 360)`;
}

export interface DistanceCalibrationWizardProps {
  link: SnapshotLink;
  /** Called whenever the current run's derived state changes, so
   * `CalibrationPage` can fold a succeeded run's wheel diameter into the
   * robot's calibration state. */
  onRun?: (run: WheelsCalibrationRun | undefined) => void;
}

export function DistanceCalibrationWizard({ link, onRun }: DistanceCalibrationWizardProps) {
  const linkId = link.id;
  const sendable = useSendable();
  const linkOpen = isLinkUsable(link) && sendable;
  const { sendCommand } = useWsActions();
  const log = useLinkLog(linkId);
  const functions = link.session?.functions ?? undefined;
  // Stakeholder (2026-09-13): `FUNCS` must never hide or block a
  // calibration run -- an absent name proves nothing (a Wi-Fi burst can
  // drop a line from the middle of the reply while the ack still
  // arrives). The button stays enabled either way; a known-missing name
  // only earns a non-blocking hint below.
  const functionKnownMissing = functions !== undefined && !functions.some((fn) => fn.name === VERB);

  const [cmText, setCmText] = useState(DEFAULT_CM);
  const cmValue = parsePositiveNumber(cmText);

  // calibration-0.20260919.2 (nezha-robot-template 12483c9) added a
  // second argument: `calwheels (cm, wheel)`, where `wheel` is the
  // known wheel diameter in mm and **0 means unknown** -- which is the
  // default and the normal case.
  //
  // Why unknown is the useful default: the firmware's old guard refused
  // any answer more than 10% from the stock 90 mm wheel, so a robot with
  // swapped wheels was refused *for measuring correctly*. Declaring a
  // wheel re-tightens that check, which is only what you want when you
  // already trust the wheel and are re-checking it.
  //
  // Sending the argument is safe against older firmware too: arguments
  // are read positionally via `runNumber(i, fallback)` and no verb
  // validates arity, so a pre-efa5a6f hex ignores it (confirmed by the
  // firmware session). So this control is not gated on the profile
  // string -- it simply does nothing on an old hex rather than erroring.
  const [wheelText, setWheelText] = useState("");
  const wheelValue = parsePositiveNumber(wheelText);

  // The run's window is anchored on the log entry *id* minted at Go,
  // not an array index -- see `RotationCalibrationWizard.tsx`'s
  // identical rationale (a bounded log ring trimmed from the front
  // would otherwise slide an index-based window out from under a
  // long-lived tab).
  const [runStartId, setRunStartId] = useState<number | undefined>(undefined);
  const derived = useMemo<WheelsCalibrationRun | undefined>(() => {
    if (runStartId === undefined) {
      return undefined;
    }
    return deriveWheelsCalibrationRun(log.filter((entry) => entry.id >= runStartId));
  }, [log, runStartId]);

  // Belt and braces: once a run reaches any terminal state, keep that
  // result even if the ring later evicts the lines it was derived from.
  // Cleared by Go.
  const latchedRef = useRef<{ startId: number; run: WheelsCalibrationRun } | undefined>(undefined);
  if (derived && derived.kind !== "running" && runStartId !== undefined) {
    latchedRef.current = { startId: runStartId, run: derived };
  }
  const latched = latchedRef.current;
  const run =
    derived?.kind === "running" && latched && latched.startId === runStartId ? latched.run : derived;

  const goDisabled = !linkOpen || run?.kind === "running" || cmValue === undefined;

  function handleGo(): void {
    if (goDisabled || cmValue === undefined) {
      return;
    }
    const last = log[log.length - 1];
    setRunStartId(last ? last.id + 1 : 0);
    // 0 is the firmware's own sentinel for "unknown", so a blank field
    // sends 0 rather than omitting the argument -- one wire shape for
    // both cases, and explicit about which one it is.
    sendCommand(linkId, "RUN", [VERB, String(cmValue), String(wheelValue ?? 0)]);
  }

  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;
  const runKey = run ? JSON.stringify(run) : "";
  useEffect(() => {
    onRunRef.current?.(run);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the run's identity, not the object
  }, [runKey]);

  const result = run?.kind === "succeeded" ? run.result : undefined;
  const diameterMm = result !== undefined ? round2(result.diameterMm) : undefined;
  const wasDiameterMm = result !== undefined ? round2((result.wasCalib * 360) / Math.PI) : undefined;

  return (
    <section className="distance-calibration-wizard" aria-label="Distance calibration">
      {!linkOpen && (
        <p className="distance-calibration-hint" data-testid="distance-calibration-idle" role="status">
          Not connected — open a link to this robot first.
        </p>
      )}

      {functionKnownMissing && (
        <p className="distance-calibration-hint" data-testid="distance-calibration-unavailable" role="status">
          The robot's function list didn't include {VERB} (lines can drop over Wi-Fi) — you can still try; the robot
          will say err if it's missing.
        </p>
      )}

      <div className="distance-calibration-config">
        <label htmlFor="distance-calibration-cm">Tape-measured line-to-line distance (cm)</label>{" "}
        <input
          id="distance-calibration-cm"
          type="number"
          inputMode="decimal"
          step="0.1"
          min="1"
          data-testid="distance-calibration-cm"
          value={cmText}
          onChange={(event) => setCmText(event.target.value)}
          disabled={!linkOpen || run?.kind === "running"}
        />
        <div className="distance-calibration-wheel">
          <label htmlFor="distance-calibration-wheel">Wheel diameter (mm), if you already know it</label>{" "}
          <input
            id="distance-calibration-wheel"
            type="number"
            inputMode="decimal"
            step="0.1"
            min="1"
            placeholder="unknown"
            data-testid="distance-calibration-wheel"
            value={wheelText}
            onChange={(event) => setWheelText(event.target.value)}
            disabled={!linkOpen || run?.kind === "running"}
          />
          <p className="distance-calibration-wheel-hint" data-testid="distance-calibration-wheel-hint">
            Leave this blank if you have swapped wheels or are not sure — that is the normal case, and it lets the robot
            measure whatever wheel it actually has. Fill it in only to re-check a wheel you already trust.
          </p>
        </div>
      </div>

      {run === undefined && (
        <ol className="distance-calibration-setup" data-testid="distance-calibration-setup">
          <li>Lay two black lines the measured distance apart, joined by a centre stripe.</li>
          <li>Place the robot just behind the first line, facing forward, then press Go.</li>
        </ol>
      )}

      <button
        type="button"
        className="distance-calibration-go"
        data-testid="distance-calibration-go"
        disabled={goDisabled}
        onClick={handleGo}
      >
        Calibrate wheels
      </button>

      {run?.kind === "running" && (
        <div className="distance-calibration-progress" data-testid="distance-calibration-progress" role="status">
          <p>Running…</p>
          {run.events.length > 0 && (
            <ul>
              {run.events.map((text, index) => (
                <li key={index}>{text}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {run?.kind === "run-error" && (
        <p className="distance-calibration-run-error" data-testid="distance-calibration-run-error" role="alert">
          The robot rejected the run request — "{VERB}" may not be registered on this build.
        </p>
      )}

      {run?.kind === "unreadable" && (
        <p className="distance-calibration-unreadable" data-testid="distance-calibration-unreadable" role="alert">
          The robot reported a result, but this console couldn't read it (unexpected shape) — check the console log
          rather than trust a guess.
        </p>
      )}

      {run?.kind === "failed" && (
        <p className="distance-calibration-failed" data-testid="distance-calibration-failed" role="alert">
          Calibration failed: {run.why}
          {run.implied !== undefined && (
            <>
              <br />
              <span data-testid="distance-calibration-failed-implied">
                The distance it drove implies a <strong>{run.implied} mm</strong> wheel
                {run.lo !== undefined && run.hi !== undefined ? ` (it accepts ${run.lo}–${run.hi} cm of travel)` : ""}. A
                wildly wrong number here usually means the start or finish line was misread on the field, not that the
                robot is broken.
              </span>
            </>
          )}
        </p>
      )}

      {run?.kind === "succeeded" && result && diameterMm !== undefined && (
        <div className="distance-calibration-result" data-testid="distance-calibration-result">
          <p className="distance-calibration-diameter" data-testid="distance-calibration-diameter">
            Wheel diameter: <strong>{diameterMm} mm</strong>
            {wasDiameterMm !== undefined && wasDiameterMm !== diameterMm ? ` (was ${wasDiameterMm} mm)` : ""}
          </p>
          <p className="distance-calibration-detail" data-testid="distance-calibration-detail">
            Measured {result.measuredCm} cm against a tape-measured {result.trueCm} cm (error {result.errorCm} cm).
          </p>
          <p className="distance-calibration-no-apply" data-testid="distance-calibration-no-apply">
            This can't be applied live — the robot has no config field for wheel calibration over the wire. Paste the
            line below into your program and reflash to use it.
          </p>
          <p className="distance-calibration-note">
            <code data-testid="distance-calibration-snippet">{wheelDiameterSnippet(diameterMm)}</code>
          </p>
        </div>
      )}
    </section>
  );
}
