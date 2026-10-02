/**
 * WheelSetupPanel.tsx — the per-wheel speed multipliers and motor ports on
 * the Calibration tab. Shows what the robot reports and writes edits back;
 * the robot saves what it is sent to flash.
 */
import { useEffect, useState } from "react";
import "./CalibrationTable.css";
import "./WheelSetupPanel.css";

export interface WheelSetup {
  /** What the wheel's commanded speed is multiplied by; negative reverses it. */
  scaleLeft: number;
  scaleRight: number;
  /** Brick motor port, 1-4. */
  portLeft: number;
  portRight: number;
}

export interface WheelSetupPanelProps {
  /** What the robot reports, or `undefined` until it has. */
  current: WheelSetup | undefined;
  canWrite: boolean;
  onWrite: (setup: WheelSetup) => void;
  /** Called with the values in the boxes whenever they change and are valid. */
  onEdit?: (setup: WheelSetup) => void;
}

const PORTS = [1, 2, 3, 4];

interface Draft {
  scaleLeft: string;
  scaleRight: string;
  portLeft: number;
  portRight: number;
}

function draftOf(setup: WheelSetup): Draft {
  return {
    scaleLeft: String(setup.scaleLeft),
    scaleRight: String(setup.scaleRight),
    portLeft: setup.portLeft,
    portRight: setup.portRight,
  };
}

function parseScale(text: string): number | undefined {
  const value = Number(text);
  return text.trim() !== "" && Number.isFinite(value) && value !== 0 ? value : undefined;
}

function setupOf(draft: Draft): WheelSetup | undefined {
  const scaleLeft = parseScale(draft.scaleLeft);
  const scaleRight = parseScale(draft.scaleRight);
  if (scaleLeft === undefined || scaleRight === undefined || draft.portLeft === draft.portRight) {
    return undefined;
  }
  return { scaleLeft, scaleRight, portLeft: draft.portLeft, portRight: draft.portRight };
}

export function WheelSetupPanel({ current, canWrite, onWrite, onEdit }: WheelSetupPanelProps) {
  const [draft, setDraftState] = useState<Draft | undefined>(current ? draftOf(current) : undefined);
  function setDraft(next: Draft | undefined): void {
    setDraftState(next);
    const setup = next ? setupOf(next) : undefined;
    if (setup) onEdit?.(setup);
  }
  useEffect(() => {
    setDraftState(current ? draftOf(current) : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-seed only when the robot's own values change
  }, [current?.scaleLeft, current?.scaleRight, current?.portLeft, current?.portRight]);

  if (!draft) {
    return (
      <div className="robot-page-panel" aria-label="Wheels and motors">
        <h3>Wheels and motors</h3>
        <p data-testid="wheel-setup-unknown" role="status">
          This robot has not reported its wheel multipliers and motor ports.
        </p>
      </div>
    );
  }

  const setup = setupOf(draft);
  const samePort = draft.portLeft === draft.portRight;

  const scaleInput = (side: "Left" | "Right", key: "scaleLeft" | "scaleRight") => (
    <label className="wheel-setup-field">
      {side}{" "}
      <input
        id={`wheel-setup-${key}`}
        type="number"
        inputMode="decimal"
        step="0.001"
        value={draft[key]}
        onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
      />
    </label>
  );

  const portSelect = (side: "Left" | "Right", key: "portLeft" | "portRight") => (
    <label className="wheel-setup-field">
      {side}{" "}
      <select
        id={`wheel-setup-${key}`}
        value={draft[key]}
        onChange={(event) => setDraft({ ...draft, [key]: Number(event.target.value) })}
      >
        {PORTS.map((port) => (
          <option key={port} value={port}>
            M{port}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="robot-page-panel" aria-label="Wheels and motors">
      <h3>Wheels and motors</h3>
      <table className="calibration-table" data-testid="wheel-setup-table">
        <tbody>
          <tr>
            <th scope="row">Wheel multipliers</th>
            <td data-testid="wheel-setup-scales">
              {scaleInput("Left", "scaleLeft")}
              {scaleInput("Right", "scaleRight")}
            </td>
          </tr>
          <tr>
            <th scope="row">Motor ports</th>
            <td data-testid="wheel-setup-ports">
              {portSelect("Left", "portLeft")}
              {portSelect("Right", "portRight")}
            </td>
          </tr>
        </tbody>
      </table>
      {samePort && (
        <p data-testid="wheel-setup-same-port" role="alert">
          The two wheels cannot be on the same port.
        </p>
      )}
      <button
        type="button"
        className="calibration-reset"
        data-testid="wheel-setup-write"
        disabled={!canWrite || !setup}
        onClick={() => {
          if (setup) onWrite(setup);
        }}
      >
        Write to robot
      </button>
    </div>
  );
}
