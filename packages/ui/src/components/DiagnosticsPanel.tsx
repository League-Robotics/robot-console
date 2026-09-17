/**
 * DiagnosticsPanel -- the robot page's "Diagnostics" tab (stakeholder,
 * 2026-09-13: "get rid of all the diagnostic crap [on the card] and put
 * it in a menu ... then you can give me all this nonsense about when it
 * was last checked, etc."). Every link the host remembers for this
 * device, including aged/stale ones the front-page card hides, with the
 * plain state text, the raw reason, timestamps, and retry timing.
 */
import type { SnapshotDevice, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { connectionLabel, linkStateText } from "../deviceDisplay";
import "./DiagnosticsPanel.css";

function when(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : new Date(value).toLocaleString();
}

export function DiagnosticsPanel({ device, current }: { device: SnapshotDevice; current: SnapshotLink }) {
  const now = Date.now();
  return (
    <section className="diagnostics-panel" data-testid="robot-tab-panel-diagnostics" aria-label="Diagnostics">
      <dl className="diagnostics-facts">
        <div>
          <dt>Role</dt>
          <dd>{device.role ?? "unknown"}</dd>
        </div>
        <div>
          <dt>Kind</dt>
          <dd>{device.kind}</dd>
        </div>
        <div>
          <dt>Program</dt>
          <dd>{device.program ?? "—"}</dd>
        </div>
        <div>
          <dt>Library version</dt>
          <dd>{device.version ?? "—"}</dd>
        </div>
        <div>
          <dt>Last seen</dt>
          <dd>{when(device.lastSeen)}</dd>
        </div>
        <div>
          <dt>Last checked</dt>
          <dd>{when(device.lastChecked)}</dd>
        </div>
      </dl>

      <h3>Connections</h3>
      <div className="diagnostics-table-wrap">
        <table className="diagnostics-table">
          <thead>
            <tr>
              <th>Connection</th>
              <th>State</th>
              <th>Reason</th>
              <th>Since</th>
              <th>Last seen</th>
              <th>Next retry</th>
              <th>Link id</th>
            </tr>
          </thead>
          <tbody>
            {device.links.map((link) => (
              <tr key={link.id} className={link.id === current.id ? "diagnostics-current" : undefined} data-testid={`diagnostics-link-${link.id}`}>
                <td>{connectionLabel(link)}{link.id === current.id ? " (this page)" : ""}</td>
                <td>{link.state}{" · "}{linkStateText(link, now, device.kind)}</td>
                <td>{link.reason ?? "—"}</td>
                <td>{when(link.since)}</td>
                <td>{when(link.lastSeen)}</td>
                <td>{when(link.nextRetryAt)}</td>
                <td className="diagnostics-mono">{link.id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
