/**
 * SequencingIndicator.tsx — surfaces `Session`'s reliability layer
 * (`v6/session.ts`) on `DeviceConsole`'s own header (ticket 005 / SUC-003).
 *
 * ## Sprint 015 ticket 008: reads `SnapshotLink.session` directly
 *
 * The retired `useSequencing(endpointId)` hook mirrored a link's
 * `seq`/`pending`/`lastDone`/`lastDoneReason` into their own `WsProvider`
 * slice; under the `Snapshot` contract those same four fields already
 * live on `SnapshotLink.session` (`wsMessages.ts`), refreshed on every
 * broadcast exactly like everything else in the snapshot -- there is no
 * separate slice left to mirror them into. So this component now takes
 * the link's own `session` field directly as a prop (`DeviceConsole.tsx`
 * already holds the `SnapshotLink` it is rendering for), rather than
 * subscribing to anything itself. `undefined` (no session open for this
 * link) is a real, ordinary value here, not an error state -- rendered
 * as an explicit "no session" line rather than blank space, so a student
 * can tell "nothing to show yet" apart from "this component is broken".
 */
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import "./SequencingIndicator.css";

export interface SequencingIndicatorProps {
  session: SnapshotLink["session"];
}

export function SequencingIndicator({ session }: SequencingIndicatorProps) {
  if (!session) {
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
          <dd>{session.seq}</dd>
        </div>
        <div className="sequencing-field">
          <dt>pending</dt>
          <dd>{session.pending}</dd>
        </div>
        <div className="sequencing-field">
          <dt>last done</dt>
          <dd>{session.lastDone}</dd>
        </div>
        <div className="sequencing-field">
          <dt>last reason</dt>
          <dd>{session.lastDoneReason}</dd>
        </div>
      </dl>
    </section>
  );
}
