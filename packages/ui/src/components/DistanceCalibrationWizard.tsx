/**
 * DistanceCalibrationWizard.tsx — the distance-calibration (`calx`)
 * wizard panel, mounted on `RobotPage` (ticket 003, SUC-003).
 *
 * Per `sprint.md`'s Detail-planning findings, `calx` is already fully
 * autonomous and self-reporting (creeps onto a first black line, drives
 * a known 90 cm gap, stops on a second line, and reports a corrected
 * wheel-calibration constant as plain `CALX:` text lines). This panel's
 * job is presentation and sequencing only, over capabilities `RobotPage`
 * already has -- no new host/wire work:
 *
 *  - **Availability, `FUNCS`-gated, not classification-gated** (see
 *    `sprint.md`'s Design Rationale): Go is enabled only once `calx`
 *    appears in `link.session.functions`; no session at all or a session
 *    whose `functions` is still `null` (no `FUNCS` round answered yet)
 *    and "answered, but `calx` absent" are rendered as two distinct,
 *    calm messages -- neither is a spinner or a timeout-shaped wait.
 *    Sprint 015 ticket 009 removed this panel's own one-shot `FUNCS`
 *    probe on mount/reopen (it duplicated no host behavior -- the
 *    harvester never auto-sends `FUNCS` either, so a session's `functions`
 *    field only ever populates from an explicit `FUNCS` press elsewhere,
 *    e.g. `CommandStrip`'s or `FunctionsPanel`'s own button); this panel
 *    just reads whatever the snapshot already reports.
 *  - **Running**, `RUN calx` dispatched via `sendCommand`, exactly the
 *    same call `FunctionsPanel`'s own Go button makes.
 *  - **Progress**, derived from the link's own rx log (`useLinkLog` --
 *    the same log `CommandStrip` reads for its `GET`-reply harvesting)
 *    via `CalibrationReport.parseCalibrationLine`.
 *    Every new `rx` line appended since this panel's own Go press is
 *    replayed, in order, into one of: an opaque progress event (rendered
 *    as its own raw text -- `"begin ..."` and `"start line found"` are
 *    already visibly distinct lines, with no need for this panel to
 *    invent semantic labels for firmware text it does not otherwise
 *    interpret), the terminal `apply` event (the snippet, rendered
 *    verbatim), a `fail` event (a distinct failure state, never a
 *    snippet), or -- outside `CalibrationReport`'s own vocabulary -- a
 *    bare `err ...` reply to the `RUN` command itself (a missing/wrong
 *    program name, per `wire_handler.cpp`'s `err 1` convention),
 *    rendered as a third, distinct terminal state so it is never
 *    confused with a `CALX:fail` line or with "unavailable".
 *  - **The run's own log window is derived, not accumulated as
 *    incremental state**: `runStartId` records the next log entry id at the
 *    moment Go was pressed, and the run's current phase is recomputed
 *    from `log.filter(id >= runStartId)` on every render (`useMemo`) --
 *    mirroring `CommandStrip`'s own `discoveredNames` derivation from
 *    `log` rather than separately-mutated state, so a cleared log or a
 *    second Go press both fall out of the same derivation with no extra
 *    reset path to keep in sync.
 *
 * No nudge control, no beam-pointer UI: this routine has neither (see
 * `sprint.md`'s Detail-planning findings) -- both are out of scope for
 * this panel by design, not merely unimplemented.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { parseCalibrationLine } from "./CalibrationReport";
import { useLinkLog, useSendable, useWsActions } from "../ws/WsProvider";
import { isLinkUsable } from "../deviceDisplay";
import "./DistanceCalibrationWizard.css";

/** Matches a bare `err ...` reply to the `RUN` command itself (e.g.
 * `err 1 #7`, `wire_handler.cpp`'s convention for an unregistered
 * program name) -- never a `CALX:`-prefixed line, since those are
 * intercepted by {@link parseCalibrationLine} first. Loose prefix
 * match, mirroring `CommandStrip.tsx`'s own `GET_REPLY_PATTERN`
 * discipline rather than a fixed reply grammar. */
const RUN_ERR_REPLY_PATTERN = /^err\b/i;

/** One calibration run's current phase, derived from the endpoint's log
 * -- see this module's doc comment ("The run's own log window..."). */
export type DistanceCalibrationRun =
  | { kind: "running"; events: string[] }
  | { kind: "run-error"; events: string[] }
  | { kind: "succeeded"; events: string[]; snippet: string }
  | { kind: "failed"; events: string[]; reason: string };

/** Pure derivation of a run's phase from the slice of `log` recorded
 * since Go was pressed -- exported so `DistanceCalibrationWizard.test.tsx`
 * can exercise it directly against fixture log slices without mounting
 * the component, mirroring `FunctionsPanel.test.tsx`'s direct tests of
 * `parseSignature`/`positionalArgs`. */
export function deriveDistanceCalibrationRun(
  entries: readonly { direction: "tx" | "rx"; line: string }[],
): DistanceCalibrationRun {
  let events: string[] = [];
  // OOP 2026-09-10: over WiFi the firmware drops lines emitted in a
  // burst, and `CALX:apply` is the last of four (measured, calib,
  // diameter, apply). The mm-per-degree value the apply line would
  // carry is already in `CALX:calib=<n> mm/deg`, so the result is
  // reconstructed from there when the apply line never shows up.
  let derivedSnippet: string | undefined;
  for (const entry of entries) {
    if (entry.direction !== "rx") {
      continue;
    }
    const event = parseCalibrationLine("CALX", entry.line);
    if (event) {
      if (event.kind === "apply") {
        return { kind: "succeeded", events, snippet: event.snippet };
      }
      if (event.kind === "fail") {
        return { kind: "failed", events, reason: event.reason };
      }
      const calib = /^calib=\s*(-?\d+(?:\.\d+)?)/.exec(event.text.trim());
      if (calib) {
        derivedSnippet = `diffDrive.setWheelCalibration(${calib[1]})`;
      }
      events = [...events, event.text];
      continue;
    }
    if (RUN_ERR_REPLY_PATTERN.test(entry.line.trim())) {
      return { kind: "run-error", events };
    }
  }
  if (derivedSnippet !== undefined && events.some((text) => /^diameter=/.test(text.trim()))) {
    // Both result lines arrived but the apply line did not -- the run
    // is complete as far as the answer goes.
    return { kind: "succeeded", events, snippet: derivedSnippet };
  }
  return { kind: "running", events };
}

/**
 * OOP 2026-09-10 (stakeholder): the wizard's answer is the wheel
 * diameter, not a "calibration" number -- this routine *is* how the
 * diameter gets measured. The template's `calx` reports it directly
 * (`CALX:diameter=90.3 mm`); an older build that only sends the
 * `CALX:apply diffDrive.setWheelCalibration(<mm per degree>)` line is
 * converted (diameter = mm/deg × 360 / π). `undefined` when neither is
 * present, in which case the raw firmware snippet is shown as-is.
 */
export function deriveWheelDiameterMm(events: readonly string[], snippet: string): number | undefined {
  for (const text of events) {
    const match = /^diameter=\s*(-?\d+(?:\.\d+)?)/.exec(text.trim());
    if (match) {
      return round2(Number(match[1]));
    }
  }
  const applied = /setWheelCalibration\(\s*(-?\d+(?:\.\d+)?)\s*\)/.exec(snippet);
  if (applied) {
    return round2((Number(applied[1]) * 360) / Math.PI);
  }
  return undefined;
}

/** The wheel diameter the robot was running with before this run, from
 * `CALX:begin ... baseline=<mm per degree>mm/deg`. */
export function deriveBaselineDiameterMm(events: readonly string[]): number | undefined {
  for (const text of events) {
    const match = /baseline=\s*(-?\d+(?:\.\d+)?)/.exec(text);
    if (match) {
      return round2((Number(match[1]) * 360) / Math.PI);
    }
  }
  return undefined;
}

/** The line a student pastes: the extension's only geometry setter
 * takes mm per shaft degree, so the diameter is written literally and
 * the conversion (π·D/360) is spelled out in the code itself rather
 * than hidden in a pre-multiplied constant. */
export function wheelDiameterSnippet(diameterMm: number): string {
  return `diffDrive.setWheelCalibration(${diameterMm} * Math.PI / 360)`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface DistanceCalibrationWizardProps {
  link: SnapshotLink;
  /** OOP 2026-09-10: called whenever the current run's derived state
   * changes, so `CalibrationPage` can fold a succeeded run's wheel
   * diameter into the robot's calibration state. */
  onRun?: (run: DistanceCalibrationRun | undefined) => void;
}

export function DistanceCalibrationWizard({ link, onRun }: DistanceCalibrationWizardProps) {
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
  const functionKnownMissing = functions !== undefined && !functions.some((fn) => fn.name === "calx");

  // OOP 2026-09-10: the run's window is anchored on the log entry *id*
  // minted at Go, not an array index. `useLinkLog` is a bounded ring
  // (MAX_LINES_PER_LINK) trimmed from the front, so in a tab that has
  // been open a while an index-based window slides and the terminal
  // `apply` line scrolls straight out of it -- the stakeholder's "lots
  // of details, then no code" report.
  const [runStartId, setRunStartId] = useState<number | undefined>(undefined);
  const derived = useMemo<DistanceCalibrationRun | undefined>(() => {
    if (runStartId === undefined) {
      return undefined;
    }
    return deriveDistanceCalibrationRun(log.filter((entry) => entry.id >= runStartId));
  }, [log, runStartId]);

  // Belt and braces: once a run has succeeded, keep that result even if
  // the ring later evicts the lines it was derived from. Cleared by Go.
  const latchedRef = useRef<{ startId: number; run: DistanceCalibrationRun } | undefined>(undefined);
  if (derived?.kind === "succeeded" && runStartId !== undefined) {
    latchedRef.current = { startId: runStartId, run: derived };
  }
  const latched = latchedRef.current;
  const run =
    derived?.kind === "running" && latched && latched.startId === runStartId ? latched.run : derived;

  const goDisabled = !linkOpen || run?.kind === "running";

  function handleGo(): void {
    if (goDisabled) {
      return;
    }
    const last = log[log.length - 1];
    setRunStartId(last ? last.id + 1 : 0);
    sendCommand(linkId, "RUN", ["calx"]);
  }

  const diameterMm = run?.kind === "succeeded" ? deriveWheelDiameterMm(run.events, run.snippet) : undefined;
  const baselineMm = run?.kind === "succeeded" ? deriveBaselineDiameterMm(run.events) : undefined;

  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;
  const runKey = run ? `${run.kind}:${run.kind === "succeeded" ? run.snippet : ""}` : "";
  useEffect(() => {
    onRunRef.current?.(run);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the run's identity, not the object
  }, [runKey]);

  return (
    <section className="distance-calibration-wizard" aria-label="Distance calibration">
      {!linkOpen && (
        <p className="distance-calibration-hint" data-testid="distance-calibration-idle" role="status">
          Not connected — open a link to this robot first.
        </p>
      )}

      {functionKnownMissing && (
        <p className="distance-calibration-hint" data-testid="distance-calibration-unavailable" role="status">
          The robot's function list didn't include calx (lines can drop over Wi-Fi) — you can still try; the robot
          will say err if it's missing.
        </p>
      )}

      {run === undefined && (
        <ol className="distance-calibration-setup" data-testid="distance-calibration-setup">
          <li>Lay two black lines 90 cm apart on the floor.</li>
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
        Calibrate X
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
          The robot rejected the run request — "calx" may not be registered on this build.
        </p>
      )}

      {run?.kind === "failed" && (
        <p className="distance-calibration-failed" data-testid="distance-calibration-failed" role="alert">
          Calibration failed: {run.reason}
        </p>
      )}

      {run?.kind === "succeeded" && (
        <div className="distance-calibration-result" data-testid="distance-calibration-result">
          {diameterMm !== undefined ? (
            <p className="distance-calibration-diameter" data-testid="distance-calibration-diameter">
              Wheel diameter: <strong>{diameterMm} mm</strong>
              {baselineMm !== undefined && baselineMm !== diameterMm ? ` (was ${baselineMm} mm)` : ""}
            </p>
          ) : (
            <p className="distance-calibration-diameter">Calibration complete.</p>
          )}
          <p className="distance-calibration-note">
            Robot reported: <code data-testid="distance-calibration-snippet">{run.snippet}</code>
          </p>
        </div>
      )}
    </section>
  );
}
