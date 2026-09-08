/**
 * SequencingIndicator.tsx — surfaces `Session`'s reliability layer
 * (`v6/session.ts`, unit-tested since sprint 1, never before wired to a
 * UI) on `RobotPage` (ticket 005 / SUC-003).
 *
 * Reads `useSequencing(endpointId)` only — `seq`/`pendingCount`/
 * `lastDone`/`lastDoneReason` travel inside `WsProvider`'s existing
 * `endpoints` snapshot (host ticket 003 projects them from `Link.session`
 * on every ack/nack), so this component has no send path and no local
 * state of its own. It is read-only by construction.
 *
 * `useSequencing` returns `undefined` whenever no session is open for
 * this endpoint (or before the first snapshot has arrived at all) --
 * per `sprint.md`'s Design Rationale, this is a snapshot field, not an
 * event stream, so "no session" is a real, ordinary value here, not an
 * error state. Rendered as an explicit "no session" line rather than
 * blank space, so a student can tell "nothing to show yet" apart from
 * "this component is broken".
 */
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { useSequencing } from "../ws/WsProvider";
import "./SequencingIndicator.css";

export interface SequencingIndicatorProps {
  endpointId: string;
}

export function SequencingIndicator({ endpointId }: SequencingIndicatorProps) {
  const sequencing: EndpointListEntry["sequencing"] = useSequencing(endpointId);

  if (!sequencing) {
    return (
      <section className="sequencing-indicator" aria-label="Sequencing state">
        <p className="sequencing-none" role="status">
          No session — sequencing state is only available while a link is open.
        </p>
      </section>
    );
  }

  return (
    <section className="sequencing-indicator" aria-label="Sequencing state">
      <dl className="sequencing-fields">
        <div className="sequencing-field">
          <dt>seq</dt>
          <dd>{sequencing.seq}</dd>
        </div>
        <div className="sequencing-field">
          <dt>pending</dt>
          <dd>{sequencing.pendingCount}</dd>
        </div>
        <div className="sequencing-field">
          <dt>last done</dt>
          <dd>{sequencing.lastDone}</dd>
        </div>
        <div className="sequencing-field">
          <dt>last reason</dt>
          <dd>{sequencing.lastDoneReason}</dd>
        </div>
      </dl>
    </section>
  );
}
