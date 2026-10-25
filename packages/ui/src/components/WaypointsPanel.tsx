/**
 * WaypointsPanel.tsx — the Drive tab's right column (2026-10-17):
 * Record the current pose as a numbered waypoint, show the list in one
 * of three pasteable forms (positions, drive legs, go-to calls), copy
 * it, and select or delete entries. The list and the path trace share
 * one waypoint array owned by `DriveTab`, so numbers and selection
 * agree between them.
 */
import { useCopied } from "../lib/clipboard";
import { Icon } from "./Icon";
import { WAYPOINT_FORMATS, waypointCode, waypointLines, type Waypoint, type WaypointFormat } from "../lib/waypointCode";
import "./WaypointsPanel.css";

export interface WaypointsPanelProps {
  waypoints: readonly Waypoint[];
  selectedId: number | null;
  format: WaypointFormat;
  canRecord: boolean;
  onRecord: () => void;
  onSelect: (id: number | null) => void;
  onDelete: (id: number) => void;
  onFormatChange: (format: WaypointFormat) => void;
}

export function WaypointsPanel({ waypoints, selectedId, format, canRecord, onRecord, onSelect, onDelete, onFormatChange }: WaypointsPanelProps) {
  const { copied, copy } = useCopied();
  const lines = waypointLines(waypoints, format);

  return (
    <section className="waypoints-panel" aria-label="Waypoints">
      <div className="waypoints-panel-head">
        <h3 className="waypoints-panel-title">Waypoints</h3>
        <div className="waypoints-panel-formats" role="group" aria-label="Waypoint format" data-testid="waypoint-format">
          {WAYPOINT_FORMATS.map((option) => (
            <button
              key={option.value}
              type="button"
              className="waypoints-panel-format"
              data-testid={`waypoint-format-${option.value}`}
              aria-pressed={format === option.value}
              onClick={() => onFormatChange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="waypoints-panel-bar">
        <button
          type="button"
          className="waypoints-panel-record"
          data-testid="waypoint-record"
          disabled={!canRecord}
          title={canRecord ? "Record the robot's current position" : "No position yet — start POSE or FULL telemetry"}
          onClick={onRecord}
        >
          <Icon name="record" size={16} />
          Record
        </button>
        <button
          type="button"
          className="waypoints-panel-copy"
          data-testid="waypoint-copy"
          disabled={waypoints.length === 0}
          onClick={() => copy(waypointCode(waypoints, format))}
        >
          <Icon name="copy" size={16} />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      {waypoints.length === 0 ? (
        <p className="waypoints-panel-empty" data-testid="waypoint-empty">
          No waypoints yet. Drive the robot, then press Record to mark where it is.
        </p>
      ) : (
        <ol className="waypoints-panel-list" data-testid="waypoint-list">
          {waypoints.map((w, index) => {
            const selected = w.id === selectedId;
            return (
              <li
                key={w.id}
                className={`waypoints-panel-item${selected ? " waypoints-panel-item-selected" : ""}`}
                data-testid={`waypoint-item-${w.n}`}
                aria-selected={selected}
                onClick={() => onSelect(selected ? null : w.id)}
              >
                <span className="waypoints-panel-number">{w.n}</span>
                <code className="waypoints-panel-text">{lines[index]}</code>
                <button
                  type="button"
                  className="waypoints-panel-delete"
                  data-testid={`waypoint-delete-${w.n}`}
                  aria-label={`Delete waypoint ${w.n}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete(w.id);
                  }}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
