/**
 * RotationCalibrationWizard.tsx — the rotation/track-width calibration
 * (`calturn`) wizard panel, mounted on `RobotPage` (ticket 004,
 * SUC-004; rewritten OOP 2026-09-18 for current firmware).
 *
 * ## OOP 2026-09-18: `cala` -> `calturn`, prose -> JSON lines, and a genuine one-click Apply
 *
 * Per `clasi/issues/calibration-calj-calc-one-click.md`, `cala` (and its
 * one-hop successor `calc`) is gone; the surviving verb is `calturn
 * (edges:number=10)`, and its reports are JSON lines
 * (`{"ev":"calturn.result", ...}` / `.quality` / `.ch` / `.restored` /
 * `.fail`), not `CALA:`-prefixed prose narrating four CW/CCW/re-verify
 * pass stages. The firmware no longer runs its own re-verification
 * pass at all -- a run ends the first time `.result` or `.fail` is
 * seen, full stop, so this module has no stage-bucketing machinery to
 * carry over from the old `cala` wizard.
 *
 * ## The trap this module exists to avoid
 *
 * `calturn.result.slip` is `tw / b` -- **this robot's own boot-record
 * track width divided by this run's own measured effective width** --
 * already computed by the firmware. The issue is explicit that this,
 * not `slip_at_anchor` (checkable-arithmetic scaffolding against the
 * *anchor* geometry `calturn` temporarily installs to run), is "the
 * value to store". `CalibrationReport.ts`'s `parseTurnResult` only ever
 * surfaces `slip`/`trackWidthCm` under those names, precisely so this
 * module can never reach for the wrong field by accident.
 *
 * ## One-click Apply -- and why `calwheels` gets none
 *
 * Measured on hardware (the issue's own table): `rotational_slip`
 * **works** over `SET`. So a succeeded `calturn` run really can be
 * one-click: this panel's own Apply button sends
 * `SET rotational_slip <slip>` directly. Contrast
 * `DistanceCalibrationWizard.tsx`, whose `calwheels` result has no
 * config field to write to at all and therefore has no Apply control
 * of any kind, not even a disabled one -- the two wizards are
 * deliberately asymmetric because the hardware is asymmetric.
 *
 * ## The anchor-overwrite and its restore
 *
 * `calturn` overwrites the robot's live geometry with an anchor while
 * it measures, then restores the original geometry on *both* the
 * success and the failure path, emitting `calturn.restored` to say what
 * it put back. That line can be dropped like any other progress line
 * (see `CalibrationReport.ts`'s own doc comment), so this panel never
 * assumes it arrived -- when present it is shown as "the robot's
 * geometry now"; when absent, the panel says plainly that it couldn't
 * confirm, rather than assuming the restore happened cleanly.
 *
 *  - **Availability, `FUNCS`-gated, not classification-gated** -- same
 *    non-blocking-hint discipline as `DistanceCalibrationWizard.tsx`.
 *  - **Running**, `RUN calturn <edges>` dispatched via `sendCommand`.
 *    `edges` is offered as the three values the issue calls "sensible"
 *    (10/18/26) rather than a free-form number, since the firmware
 *    silently rounds whatever it's given to the nearest `8n+2`.
 *  - **The run's own log window is derived, not accumulated** -- same
 *    `runStartId`/`log.filter` discipline as the distance wizard.
 *
 * No nudge control, no beam-pointer UI: this routine has neither (see
 * the distance wizard's identical carve-out, unchanged since ticket 004).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import {
  formatCalibrationEvent,
  parseCalibrationLine,
  parseTurnResult,
  parseTurnRestored,
  type RestoredGeometry,
  type TurnResult,
} from "./CalibrationReport";
import { useLinkLog, useSendable, useWsActions } from "../ws/WsProvider";
import { isLinkUsable } from "../deviceDisplay";
import "./RotationCalibrationWizard.css";

/** Matches a bare `err ...` reply to the `RUN` command itself -- same
 * pattern and rationale as `DistanceCalibrationWizard.tsx`'s identical
 * constant. */
const RUN_ERR_REPLY_PATTERN = /^err\b/i;

/** The wire verb this wizard runs -- isolated to this one constant, see
 * `CalibrationReport.ts`'s own doc comment. */
const VERB = "calturn";

/** The three "sensible offerings" per the issue: the firmware silently
 * rounds any `edges` value to the nearest `8n+2` and says so if it
 * changed the value, so a free-form number invites a rounding surprise
 * a fixed set avoids. */
const EDGE_OPTIONS = ["10", "18", "26"] as const;
const DEFAULT_EDGES: (typeof EDGE_OPTIONS)[number] = "10";

/** One calibration run's current phase, derived from the endpoint's log
 * -- see this module's doc comment. `restored`, when known, is carried
 * on every terminal kind (and `running`, in case it somehow raced
 * ahead) since `calturn.restored` can arrive on both the success and
 * the failure path. */
export type TurnCalibrationRun =
  | { kind: "running"; events: string[]; restored?: RestoredGeometry | undefined }
  | { kind: "run-error"; events: string[]; restored?: RestoredGeometry | undefined }
  | { kind: "unreadable"; events: string[]; restored?: RestoredGeometry | undefined }
  | { kind: "failed"; events: string[]; why: string; restored?: RestoredGeometry | undefined }
  | { kind: "succeeded"; events: string[]; result: TurnResult; restored?: RestoredGeometry | undefined };

/** Pure derivation of a run's phase from the slice of `log` recorded
 * since Go was pressed -- exported so `RotationCalibrationWizard.test.tsx`
 * can exercise it directly against fixture log slices.
 *
 * Drop-tolerant by construction: `.quality`/`.ch` lines, if present,
 * only ever add progress text, never gate the terminal state. Once a
 * `.result`/`.fail`/bare-`err` terminal state is reached, the loop
 * keeps consuming entries -- not to look for more terminal lines (the
 * issue's contract is exactly one `.result` or `.fail` per run), but
 * because `calturn.restored` is emitted *after* the terminal line on
 * the real wire and must still be picked up if it arrives.
 */
export function deriveTurnCalibrationRun(
  entries: readonly { direction: "tx" | "rx"; line: string }[],
): TurnCalibrationRun {
  let events: string[] = [];
  let terminal:
    | { kind: "run-error" }
    | { kind: "unreadable" }
    | { kind: "failed"; why: string }
    | { kind: "succeeded"; result: TurnResult }
    | undefined;
  let restored: RestoredGeometry | undefined;

  for (const entry of entries) {
    if (entry.direction !== "rx") {
      continue;
    }
    const parsed = parseCalibrationLine(entry.line);
    if (parsed) {
      if (parsed.verb !== VERB) {
        // Noise from a different routine's own JSON lines (e.g.
        // `calwheels` traffic on the same link) -- tolerated silently.
        continue;
      }
      if (parsed.kind === "other" && parsed.suffix === "restored") {
        // Validated best-effort: an unparsable `.restored` line is
        // simply not adopted, never surfaced as a wrong geometry.
        restored = parseTurnRestored(parsed.fields) ?? restored;
        continue;
      }
      if (terminal !== undefined) {
        // Already terminal -- a stray duplicate `.result`/`.fail`, or
        // more `.quality`/`.ch` lines, are tolerated and ignored.
        continue;
      }
      if (parsed.kind === "result") {
        const result = parseTurnResult(parsed.fields);
        terminal = result ? { kind: "succeeded", result } : { kind: "unreadable" };
        continue;
      }
      if (parsed.kind === "fail") {
        terminal = { kind: "failed", why: parsed.why ?? "no reason given" };
        continue;
      }
      events = [...events, formatCalibrationEvent(parsed.ev, parsed.fields)];
      continue;
    }
    if (terminal === undefined && RUN_ERR_REPLY_PATTERN.test(entry.line.trim())) {
      terminal = { kind: "run-error" };
    }
  }

  if (terminal === undefined) {
    return { kind: "running", events, restored };
  }
  if (terminal.kind === "run-error") {
    return { kind: "run-error", events, restored };
  }
  if (terminal.kind === "unreadable") {
    return { kind: "unreadable", events, restored };
  }
  if (terminal.kind === "failed") {
    return { kind: "failed", events, why: terminal.why, restored };
  }
  return { kind: "succeeded", events, result: terminal.result, restored };
}

export interface RotationCalibrationWizardProps {
  link: SnapshotLink;
  /** Called whenever the current run's derived state changes --
   * `CalibrationPage` folds a succeeded run's reported track width and
   * firmware-computed slip into the robot's calibration state. */
  onRun?: (run: TurnCalibrationRun | undefined) => void;
  /** The rotation run is meaningless without a wheel diameter --
   * `CalibrationPage` blocks Go until one is known. */
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
  // Stakeholder (2026-09-13): `FUNCS` must never hide or block a
  // calibration run -- same discipline as the distance wizard.
  const functionKnownMissing = functions !== undefined && !functions.some((fn) => fn.name === VERB);

  const [edges, setEdges] = useState<string>(DEFAULT_EDGES);

  const [runStartId, setRunStartId] = useState<number | undefined>(undefined);
  const derived = useMemo<TurnCalibrationRun | undefined>(() => {
    if (runStartId === undefined) {
      return undefined;
    }
    return deriveTurnCalibrationRun(log.filter((entry) => entry.id >= runStartId));
  }, [log, runStartId]);

  const latchedRef = useRef<{ startId: number; run: TurnCalibrationRun } | undefined>(undefined);
  if (derived && derived.kind !== "running" && runStartId !== undefined) {
    latchedRef.current = { startId: runStartId, run: derived };
  }
  const latched = latchedRef.current;
  const run =
    derived?.kind === "running" && latched && latched.startId === runStartId ? latched.run : derived;

  const goDisabled = !linkOpen || disabled || run?.kind === "running";

  // The value actually sent by the last Apply press, so a stale
  // confirmation never survives a fresh run or a different result.
  const [appliedSlip, setAppliedSlip] = useState<number | undefined>(undefined);

  function handleGo(): void {
    if (goDisabled) {
      return;
    }
    setAppliedSlip(undefined);
    const last = log[log.length - 1];
    setRunStartId(last ? last.id + 1 : 0);
    sendCommand(linkId, "RUN", [VERB, edges]);
  }

  function handleApply(result: TurnResult): void {
    sendCommand(linkId, "SET", ["rotational_slip", String(result.slip)]);
    setAppliedSlip(result.slip);
  }

  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;
  const runKey = run ? JSON.stringify(run) : "";
  useEffect(() => {
    onRunRef.current?.(run);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the run's identity, not the object
  }, [runKey]);

  function renderRestored(restored: RestoredGeometry | undefined) {
    return restored ? (
      <p className="rotation-calibration-restored" data-testid="rotation-calibration-restored">
        Robot's geometry now: track width <strong>{restored.trackWidthCm} cm</strong>, slip{" "}
        <strong>{restored.slip}</strong> — calturn restores this after every run, success or fail.
      </p>
    ) : (
      <p className="rotation-calibration-restored-unknown" data-testid="rotation-calibration-restored-unknown">
        Couldn't confirm the robot's geometry after this run — the restore-confirmation line didn't arrive. Treat it
        as unknown rather than assuming the restore went cleanly.
      </p>
    );
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
          The robot's function list didn't include {VERB} (lines can drop over Wi-Fi) — you can still try; the robot
          will say err if it's missing.
        </p>
      )}

      {disabled && (
        <p className="rotation-calibration-hint" data-testid="rotation-calibration-blocked" role="status">
          {disabledReason ?? "Not available yet."}
        </p>
      )}

      {!disabled && (
        <div className="rotation-calibration-config">
          <label htmlFor="rotation-calibration-edges">Transitions per channel</label>{" "}
          <select
            id="rotation-calibration-edges"
            data-testid="rotation-calibration-edges"
            value={edges}
            onChange={(event) => setEdges(event.target.value)}
            disabled={!linkOpen || run?.kind === "running"}
          >
            {EDGE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <p className="rotation-calibration-edges-note">
            The firmware rounds this to the nearest valid count (8n+2) and says so if it changed it.
          </p>
        </div>
      )}

      {!disabled && run === undefined && (
        <ol className="rotation-calibration-setup" data-testid="rotation-calibration-setup">
          <li>Lay out the alternating iron cross — eight 45° radial wedges.</li>
          <li>Place the robot centred on the cross, then press Go.</li>
        </ol>
      )}

      <button
        type="button"
        className="rotation-calibration-go"
        data-testid="rotation-calibration-go"
        disabled={goDisabled}
        onClick={handleGo}
      >
        Calibrate turn
      </button>

      {run?.kind === "running" && (
        <div className="rotation-calibration-progress" data-testid="rotation-calibration-progress" role="status">
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
        <p className="rotation-calibration-run-error" data-testid="rotation-calibration-run-error" role="alert">
          The robot rejected the run request — "{VERB}" may not be registered on this build.
        </p>
      )}

      {run?.kind === "unreadable" && (
        <p className="rotation-calibration-unreadable" data-testid="rotation-calibration-unreadable" role="alert">
          The robot reported a result, but this console couldn't read it (unexpected shape) — check the console log
          rather than trust a guess.
        </p>
      )}

      {run?.kind === "failed" && (
        <>
          <p className="rotation-calibration-failed" data-testid="rotation-calibration-failed" role="alert">
            Calibration failed: {run.why}
          </p>
          {renderRestored(run.restored)}
        </>
      )}

      {run?.kind === "succeeded" && (
        <div className="rotation-calibration-result" data-testid="rotation-calibration-result">
          <p className="rotation-calibration-track" data-testid="rotation-calibration-track">
            Effective track width this run measured: <strong>{run.result.b} cm</strong>
          </p>
          <p className="rotation-calibration-slip" data-testid="rotation-calibration-slip">
            Rotational slip: <strong>{run.result.slip}</strong> ({run.result.trackWidthCm} cm boot-record track width
            / {run.result.b} cm measured this run)
          </p>
          <button
            type="button"
            className="rotation-calibration-apply"
            data-testid="rotation-calibration-apply"
            onClick={() => handleApply(run.result)}
          >
            Apply
          </button>
          {appliedSlip === run.result.slip && (
            <p className="rotation-calibration-applied" data-testid="rotation-calibration-applied" role="status">
              Applied — rotational_slip set to {run.result.slip}.
            </p>
          )}
          {renderRestored(run.restored)}
        </div>
      )}
    </section>
  );
}
