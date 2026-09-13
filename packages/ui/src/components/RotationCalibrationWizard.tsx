/**
 * RotationCalibrationWizard.tsx — the rotation-calibration (`cala`)
 * wizard panel, mounted on `RobotPage` (ticket 004, SUC-004).
 *
 * Mirrors `DistanceCalibrationWizard.tsx`'s structure exactly (see that
 * module's own doc comment for the full rationale this one shares:
 * `FUNCS`-gated availability read straight from `link.session.functions`
 * with no on-open probe of its own (sprint 015 ticket 009), `RUN`-dispatch
 * on Go, progress derived from the link's own rx log via
 * `CalibrationReport.parseCalibrationLine`, the run's phase recomputed
 * from `log.filter(id >= runStartId)` on every render rather than
 * accumulated as incremental state) — per `sprint.md`'s Step 3 module
 * table, this wizard "differs from the distance wizard mainly in having
 * more distinct pass stages to show ... rather than in its underlying
 * mechanics."
 *
 * `test/calibratea.ts` (`nezha-robot-template`, read directly) is a
 * fully autonomous rotation calibration with **no beam pointer and no
 * manual nudge control**: the robot spins clockwise then
 * counter-clockwise against a black-tape cross, timing white-to-black
 * edge crossings on one reflectance channel, then re-runs both
 * directions a second time with the correction applied as its own
 * built-in verification pass. It narrates progress the same way `calx`
 * does -- plain `CALA:` text lines via `emitLine()` -- but marks four
 * distinct pass boundaries with their own marker lines, read verbatim
 * from the routine's own source: `CALA:pass clockwise`, `CALA:pass
 * counter-clockwise`, `CALA:check clockwise`, `CALA:check
 * counter-clockwise`. This module's own `deriveRotationCalibrationRun`
 * buckets every other progress line under whichever of those four
 * stages was most recently announced (or, before the first marker, an
 * undifferentiated "leading" bucket for lines like `CALA:begin ...`) --
 * per `sprint.md`'s Step 3, this CW/CCW/re-verify pass structure is
 * this component's own state, deliberately *not* pushed into the shared
 * `CalibrationReport.ts` parser, which stays prefix-and-shape-only.
 *
 * **The snippet is never computed by this panel** -- same rule as the
 * distance wizard: the observed `CALA:apply ...` line is rendered
 * verbatim, never a value reconstructed from the intermediate `CALA:
 * measured b=...`/`CALA:derived slip=...` lines.
 *
 * **`apply` is *not* the last line on the wire, unlike `calx`'s
 * identical-looking `CALX:apply` terminal line.** `test/calibratea.ts`
 * (read directly) emits `CALA:apply ...` once the correction is
 * computed, then immediately *sets* that correction and re-runs both
 * directions a second time -- `CALA:check clockwise`/`CALA:check
 * counter-clockwise` and their own progress lines follow `apply` on the
 * wire, not precede it. So `deriveRotationCalibrationRun` treats `apply`
 * as "the result is now known", not "stop reading the log": it records
 * the snippet and *keeps consuming* subsequent entries, so the two
 * re-verification stages still populate and render even though the run
 * is already `succeeded`. A `CALA:fail` line arriving after `apply` (the
 * re-verification pass itself can fail) overrides that outcome -- the
 * run flips to `failed`, discarding the snippet, because a failed
 * re-verification must never leave a green result standing.
 *
 * No nudge control, no beam-pointer UI: this routine has neither -- see
 * this module's own doc comment above and the distance wizard's
 * identical carve-out.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { parseCalibrationLine } from "./CalibrationReport";
import { useLinkLog, useSendable, useWsActions } from "../ws/WsProvider";
import { isLinkUsable } from "../deviceDisplay";
import "./RotationCalibrationWizard.css";

/** Matches a bare `err ...` reply to the `RUN` command itself -- same
 * pattern and rationale as `DistanceCalibrationWizard.tsx`'s identical
 * constant. */
const RUN_ERR_REPLY_PATTERN = /^err\b/i;

/** One of the four distinct pass stages `cala` narrates, in the order
 * its own marker lines announce them (`test/calibratea.ts`, read
 * directly: `CALA:pass clockwise`, `CALA:pass counter-clockwise`,
 * `CALA:check clockwise`, `CALA:check counter-clockwise`). */
export type RotationCalibrationStageId = "cw" | "ccw" | "check-cw" | "check-ccw";

/** Display order and labels for the four stages, in the order the
 * routine announces them. */
export const ROTATION_CALIBRATION_STAGE_ORDER: readonly RotationCalibrationStageId[] = [
  "cw",
  "ccw",
  "check-cw",
  "check-ccw",
];

export const ROTATION_CALIBRATION_STAGE_LABELS: Record<RotationCalibrationStageId, string> = {
  cw: "Clockwise pass",
  ccw: "Counter-clockwise pass",
  "check-cw": "Re-verification — clockwise",
  "check-ccw": "Re-verification — counter-clockwise",
};

/** The exact marker text (after `CALA:` is stripped) `test/calibratea.ts`
 * emits to announce each stage -- read directly from that file, not
 * guessed at. */
const STAGE_MARKER_TEXT: Record<string, RotationCalibrationStageId> = {
  "pass clockwise": "cw",
  "pass counter-clockwise": "ccw",
  "check clockwise": "check-cw",
  "check counter-clockwise": "check-ccw",
};

/** One stage's accumulated progress lines, in the order they arrived. */
export interface RotationCalibrationStageEvents {
  stage: RotationCalibrationStageId;
  events: string[];
}

/** One calibration run's current phase, derived from the endpoint's log
 * -- see this module's doc comment. */
export type RotationCalibrationRun =
  | { kind: "running"; leadingEvents: string[]; stages: RotationCalibrationStageEvents[] }
  | { kind: "run-error"; leadingEvents: string[]; stages: RotationCalibrationStageEvents[] }
  | { kind: "succeeded"; leadingEvents: string[]; stages: RotationCalibrationStageEvents[]; snippet: string }
  | { kind: "failed"; reason: string };

/** Pure derivation of a run's phase from the slice of `log` recorded
 * since Go was pressed -- exported so `RotationCalibrationWizard.test.tsx`
 * can exercise it directly against fixture log slices, mirroring
 * `DistanceCalibrationWizard.tsx`'s `deriveDistanceCalibrationRun`.
 *
 * `apply` does not end the loop (see this module's doc comment: the
 * real firmware keeps narrating both re-verification stages after its
 * own `apply` line) -- the snippet is recorded and iteration continues,
 * so a later `check clockwise`/`check counter-clockwise` marker still
 * opens its own stage bucket, and a later `fail` still overrides the
 * outcome to `failed`, discarding the snippet. */
export function deriveRotationCalibrationRun(
  entries: readonly { direction: "tx" | "rx"; line: string }[],
): RotationCalibrationRun {
  const leadingEvents: string[] = [];
  const stages: RotationCalibrationStageEvents[] = [];
  let current: RotationCalibrationStageEvents | undefined;
  let snippet: string | undefined;
  // OOP 2026-09-10: over WiFi the firmware drops lines emitted in a
  // burst, and `CALA:apply` rides in one (slope, measured, derived,
  // apply, check -- five lines back to back). The result is already on
  // the wire one line earlier, in `CALA:derived slip=<n> ...`, and the
  // apply line only restates that same number, so it is reconstructed
  // from there when the apply line never shows up.
  let derivedSnippet: string | undefined;

  for (const entry of entries) {
    if (entry.direction !== "rx") {
      continue;
    }
    const event = parseCalibrationLine("CALA", entry.line);
    if (event) {
      if (event.kind === "progress") {
        const slip = /^derived slip=\s*(-?\d+(?:\.\d+)?)/.exec(event.text.trim());
        if (slip) {
          derivedSnippet = `diffDrive.setConfigValue(ConfigField.RotationalSlip, ${slip[1]})`;
        }
      }
      if (event.kind === "apply") {
        // The result is now known, but the routine is not done talking
        // -- its own re-verification passes still follow on the wire.
        // Keep reading so those stages still populate.
        snippet = event.snippet;
        continue;
      }
      if (event.kind === "fail") {
        // Overrides any snippet already recorded -- a fail during
        // re-verification must not leave a green result standing.
        return { kind: "failed", reason: event.reason };
      }
      const stageId = STAGE_MARKER_TEXT[event.text];
      if (stageId) {
        current = { stage: stageId, events: [] };
        stages.push(current);
        continue;
      }
      if (current) {
        current.events.push(event.text);
      } else {
        leadingEvents.push(event.text);
      }
      continue;
    }
    if (RUN_ERR_REPLY_PATTERN.test(entry.line.trim())) {
      return { kind: "run-error", leadingEvents, stages };
    }
  }
  const result = snippet ?? derivedSnippet;
  if (result !== undefined) {
    return { kind: "succeeded", leadingEvents, stages, snippet: result };
  }
  return { kind: "running", leadingEvents, stages };
}

/** The robot's own `measured b=<n>cm` line -- the effective track
 * width as the calibration image measured it, uncorrected for the
 * wheel diameter it assumed (see `CalibrationPage.correctTrackWidth`). */
export function reportedTrackWidthCm(run: RotationCalibrationRun): number | undefined {
  if (run.kind !== "succeeded" && run.kind !== "running") {
    return undefined;
  }
  const texts = [...run.leadingEvents, ...run.stages.flatMap((stage) => stage.events)];
  for (const text of texts) {
    const match = /^measured b=\s*(-?\d+(?:\.\d+)?)/.exec(text.trim());
    if (match) {
      return Number(match[1]);
    }
  }
  return undefined;
}

/** The robot's own `CALA:derived slip=<n> = track <a> / b <b>` line
 * (ticket 018-013, item 4) -- the firmware's own slip computation,
 * already on the wire (it is where `deriveRotationCalibrationRun`'s own
 * `derivedSnippet` fallback reads the number from, when the `apply` line
 * itself is dropped over WiFi). Never folded into `lib/calibration.ts`'s
 * own `DerivedCalibration.rotationalSlip`: the firmware divides its own
 * hard-coded 11.5 cm anchor by the reported width, not this robot's
 * actual measured track width, so the two numbers answer different
 * questions and both are shown, side by side, in the "Current
 * calibration" table (`CalibrationTable.tsx`) -- see this module's own
 * doc comment's "The image's own `derived slip` is ignored" note in
 * `lib/calibration.ts`. */
export function robotReportedSlip(run: RotationCalibrationRun): number | undefined {
  if (run.kind !== "succeeded" && run.kind !== "running") {
    return undefined;
  }
  const texts = [...run.leadingEvents, ...run.stages.flatMap((stage) => stage.events)];
  for (const text of texts) {
    const match = /^derived slip=\s*(-?\d+(?:\.\d+)?)/.exec(text.trim());
    if (match) {
      return Number(match[1]);
    }
  }
  return undefined;
}

export interface RotationCalibrationWizardProps {
  link: SnapshotLink;
  /** OOP 2026-09-10: called whenever the current run's derived state
   * changes -- `CalibrationPage` folds a succeeded run's reported track
   * width into the robot's calibration state, and drops it again on a
   * failed re-verification. */
  onRun?: (run: RotationCalibrationRun | undefined) => void;
  /** OOP 2026-09-10: the rotation run is meaningless without a wheel
   * diameter -- `CalibrationPage` blocks Go until one is known. */
  disabled?: boolean;
  disabledReason?: string;
}

export function RotationCalibrationWizard({ link, onRun, disabled = false, disabledReason }: RotationCalibrationWizardProps) {
  const linkId = link.id;
  const sendable = useSendable();
  const linkOpen = isLinkUsable(link) && sendable;
  const { sendCommand } = useWsActions();
  const log = useLinkLog(linkId);
  const functions = link.session?.functions ?? undefined;
  // Stakeholder (2026-09-13, and reaffirmed the same day root-causing
  // "only CalX" on a robot that genuinely has `cala`): `FUNCS` must
  // never hide or block a calibration run. A Wi-Fi burst can drop a
  // line from the middle of the reply while the ack still arrives, so
  // an absent name proves nothing -- the button stays enabled either
  // way, and a known-missing name only earns a non-blocking hint below.
  const functionKnownMissing = functions !== undefined && !functions.some((fn) => fn.name === "cala");

  // OOP 2026-09-10: the run's window is anchored on the log entry *id*
  // minted at Go, not an array index. `useLinkLog` is a bounded ring
  // (MAX_LINES_PER_LINK) trimmed from the front, so in a tab that has
  // been open a while an index-based window slides and the terminal
  // `apply` line scrolls straight out of it -- the stakeholder's "lots
  // of details, then no code" report.
  const [runStartId, setRunStartId] = useState<number | undefined>(undefined);
  const derived = useMemo<RotationCalibrationRun | undefined>(() => {
    if (runStartId === undefined) {
      return undefined;
    }
    return deriveRotationCalibrationRun(log.filter((entry) => entry.id >= runStartId));
  }, [log, runStartId]);

  // Belt and braces: once a run has succeeded, keep that result even if
  // the ring later evicts the lines it was derived from. Cleared by Go.
  const latchedRef = useRef<{ startId: number; run: RotationCalibrationRun } | undefined>(undefined);
  if (derived?.kind === "succeeded" && runStartId !== undefined) {
    latchedRef.current = { startId: runStartId, run: derived };
  }
  const latched = latchedRef.current;
  const run =
    derived?.kind === "running" && latched && latched.startId === runStartId ? latched.run : derived;

  const goDisabled = !linkOpen || disabled || run?.kind === "running";

  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;
  const runKey = run
    ? `${run.kind}:${run.kind === "succeeded" ? run.snippet : ""}:${run.kind === "failed" ? run.reason : ""}`
    : "";
  useEffect(() => {
    onRunRef.current?.(run);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the run's identity, not the object
  }, [runKey]);

  function handleGo(): void {
    if (goDisabled) {
      return;
    }
    const last = log[log.length - 1];
    setRunStartId(last ? last.id + 1 : 0);
    sendCommand(linkId, "RUN", ["cala"]);
  }

  return (
    <section className="rotation-calibration-wizard" aria-label="Rotation calibration">
      {!linkOpen && (
        <p className="rotation-calibration-hint" data-testid="rotation-calibration-idle" role="status">
          Not connected — open a link to this robot first.
        </p>
      )}

      {functionKnownMissing && (
        <p className="rotation-calibration-hint" data-testid="rotation-calibration-unavailable" role="status">
          The robot's function list didn't include cala (lines can drop over Wi-Fi) — you can still try; the robot
          will say err if it's missing.
        </p>
      )}

      {disabled && (
        <p className="rotation-calibration-hint" data-testid="rotation-calibration-blocked" role="status">
          {disabledReason ?? "Not available yet."}
        </p>
      )}

      {!disabled && run === undefined && (
        <ol className="rotation-calibration-setup" data-testid="rotation-calibration-setup">
          <li>Lay two strips of black tape crossing at right angles on the floor.</li>
          <li>Place the robot at the centre of the cross, then press Go.</li>
        </ol>
      )}

      <button
        type="button"
        className="rotation-calibration-go"
        data-testid="rotation-calibration-go"
        disabled={goDisabled}
        onClick={handleGo}
      >
        Calibrate A
      </button>

      {(run?.kind === "running" || run?.kind === "succeeded") && (
        <div className="rotation-calibration-progress" data-testid="rotation-calibration-progress" role="status">
          <p>{run.kind === "running" ? "Running…" : "Verifying the correction…"}</p>
          {run.leadingEvents.length > 0 && (
            <ul className="rotation-calibration-leading">
              {run.leadingEvents.map((text, index) => (
                <li key={index}>{text}</li>
              ))}
            </ul>
          )}
          {run.stages.map((stageEvents, index) => (
            <div
              key={index}
              className="rotation-calibration-stage"
              data-testid={`rotation-calibration-stage-${stageEvents.stage}`}
            >
              <p className="rotation-calibration-stage-label">
                {ROTATION_CALIBRATION_STAGE_LABELS[stageEvents.stage]}
              </p>
              {stageEvents.events.length > 0 && (
                <ul>
                  {stageEvents.events.map((text, eventIndex) => (
                    <li key={eventIndex}>{text}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      {run?.kind === "run-error" && (
        <p className="rotation-calibration-run-error" data-testid="rotation-calibration-run-error" role="alert">
          The robot rejected the run request — "cala" may not be registered on this build.
        </p>
      )}

      {run?.kind === "failed" && (
        <p className="rotation-calibration-failed" data-testid="rotation-calibration-failed" role="alert">
          Calibration failed: {run.reason}
        </p>
      )}

      {run?.kind === "succeeded" && (
        <div className="rotation-calibration-result" data-testid="rotation-calibration-result">
          {reportedTrackWidthCm(run) !== undefined ? (
            <p className="rotation-calibration-track" data-testid="rotation-calibration-track">
              Effective track width as the robot measured it: <strong>{reportedTrackWidthCm(run)} cm</strong>
            </p>
          ) : (
            <p className="rotation-calibration-track">Calibration complete.</p>
          )}
          <p className="rotation-calibration-note">
            Robot reported: <code data-testid="rotation-calibration-snippet">{run.snippet}</code>
          </p>
        </div>
      )}
    </section>
  );
}
