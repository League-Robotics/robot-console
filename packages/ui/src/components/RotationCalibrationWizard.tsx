/**
 * RotationCalibrationWizard.tsx — the rotation-calibration (`cala`)
 * wizard panel, mounted on `RobotPage` (ticket 004, SUC-004).
 *
 * Mirrors `DistanceCalibrationWizard.tsx`'s structure exactly (see that
 * module's own doc comment for the full rationale this one shares:
 * `FUNCS`-gated availability, `RUN`-dispatch on Go, progress derived
 * from the endpoint's own rx log via `CalibrationReport.parseCalibrationLine`,
 * the run's phase recomputed from `log.slice(runStartIndex)` on every
 * render rather than accumulated as incremental state) — per
 * `sprint.md`'s Step 3 module table, this wizard "differs from the
 * distance wizard mainly in having more distinct pass stages to show
 * ... rather than in its underlying mechanics."
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
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { parseCalibrationLine } from "./CalibrationReport";
import { useEndpointLog, useWsActions } from "../ws/WsProvider";
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

  for (const entry of entries) {
    if (entry.direction !== "rx") {
      continue;
    }
    const event = parseCalibrationLine("CALA", entry.line);
    if (event) {
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
  if (snippet !== undefined) {
    return { kind: "succeeded", leadingEvents, stages, snippet };
  }
  return { kind: "running", leadingEvents, stages };
}

export interface RotationCalibrationWizardProps {
  device: EndpointListEntry;
}

export function RotationCalibrationWizard({ device }: RotationCalibrationWizardProps) {
  const endpointId = device.endpointId;
  const linkOpen = device.sessionOpen;
  const { sendCommand } = useWsActions();
  const log = useEndpointLog(endpointId);
  const functions = device.functions;
  const available = functions?.some((fn) => fn.name === "cala") ?? false;

  // One-shot FUNCS probe on mount (if already open) and on every
  // closed->open transition -- identical shape to
  // DistanceCalibrationWizard's own effect.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = linkOpen;
    if (linkOpen && !wasOpen) {
      sendCommand(endpointId, "FUNCS");
    }
  }, [linkOpen, endpointId, sendCommand]);

  const [runStartIndex, setRunStartIndex] = useState<number | undefined>(undefined);

  const run = useMemo<RotationCalibrationRun | undefined>(() => {
    if (runStartIndex === undefined) {
      return undefined;
    }
    return deriveRotationCalibrationRun(log.slice(runStartIndex));
  }, [log, runStartIndex]);

  const goDisabled = !linkOpen || !available || run?.kind === "running";

  function handleGo(): void {
    if (goDisabled) {
      return;
    }
    setRunStartIndex(log.length);
    sendCommand(endpointId, "RUN", ["cala"]);
  }

  function handleCopy(snippet: string): void {
    try {
      void navigator.clipboard?.writeText(snippet);
    } catch {
      // Clipboard unavailable (permissions, non-secure context, or no
      // Clipboard API at all in a test's jsdom) -- the snippet text is
      // still visible and selectable either way.
    }
  }

  return (
    <section className="rotation-calibration-wizard" aria-label="Rotation calibration">
      {functions === undefined && (
        <p className="rotation-calibration-hint" data-testid="rotation-calibration-idle" role="status">
          Checking whether this robot supports calibration…
        </p>
      )}

      {functions !== undefined && !available && (
        <p className="rotation-calibration-hint" data-testid="rotation-calibration-unavailable" role="status">
          This robot doesn't support calibration yet.
        </p>
      )}

      {available && run === undefined && (
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
        Go
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
          <p>Calibration complete — paste this into your program:</p>
          <code className="rotation-calibration-snippet" data-testid="rotation-calibration-snippet">
            {run.snippet}
          </code>
          <button
            type="button"
            className="rotation-calibration-copy"
            data-testid="rotation-calibration-copy"
            onClick={() => handleCopy(run.snippet)}
          >
            Copy
          </button>
        </div>
      )}
    </section>
  );
}
