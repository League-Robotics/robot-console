/**
 * StatusPanel.tsx — sends the unsequenced `STATUS` verb and displays the
 * device's most recent `status ...` reply (ticket 005 / SUC-001,
 * SUC-004).
 *
 * `STATUS` is unsequenced (`@robot-console/protocol`'s
 * `isSequencedVerb` is the single authority for that; `STATUS` is not
 * in its list, per `sprint.md`'s own correction of the roadmap's looser
 * phrasing against protocol.md), so this panel never touches
 * `sequencing` -- its reply arrives as an ordinary `line` message, the
 * same path `DeviceConsole` already renders every line through. This
 * panel does not duplicate that raw log; it reads the same per-endpoint
 * log buffer (`useEndpointLog`, hoisted in `WsProvider`) and picks out
 * the most recent line that looks like a `status` reply, so a student
 * gets a readable answer without needing to scroll the console for it.
 *
 * "Looks like a status reply" is deliberately a loose prefix match
 * (`/^status\b/i`) rather than a parsed/typed shape: this library's
 * wire layer holds no per-verb reply grammar (`v6/codec.ts`'s own
 * "no verb table" discipline), so a hand-rolled parser here would be
 * exactly the kind of invented structure the firmware's actual reply
 * does not promise to satisfy. The raw text is shown verbatim.
 */
import { useMemo } from "react";
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { useEndpointLog, useWsActions } from "../ws/WsProvider";
import "./StatusPanel.css";

const STATUS_REPLY_PATTERN = /^status\b/i;

export interface StatusPanelProps {
  device: EndpointListEntry;
}

export function StatusPanel({ device }: StatusPanelProps) {
  const endpointId = device.endpointId;
  const { sendCommand } = useWsActions();
  const log = useEndpointLog(endpointId);

  const lastStatusLine = useMemo(() => {
    for (let i = log.length - 1; i >= 0; i--) {
      const entry = log[i];
      if (entry && entry.direction === "rx" && STATUS_REPLY_PATTERN.test(entry.line.trimStart())) {
        return entry.line;
      }
    }
    return undefined;
  }, [log]);

  const linkOpen = device.sessionOpen;

  return (
    <section className="status-panel" aria-label="Status">
      <div className="status-panel-toolbar">
        <button
          type="button"
          className="status-panel-button"
          disabled={!linkOpen}
          onClick={() => sendCommand(endpointId, "STATUS")}
        >
          Send STATUS
        </button>
      </div>
      {!linkOpen && (
        <p className="status-panel-hint" role="status">
          No link open — open a link before requesting status.
        </p>
      )}
      <pre className="status-panel-reply" data-testid="status-panel-reply">
        {lastStatusLine ?? "No STATUS reply yet."}
      </pre>
    </section>
  );
}
