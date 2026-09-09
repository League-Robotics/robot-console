/**
 * StatusPanel.tsx — the robot's parsed `status` reply, rendered
 * read-mostly on `RobotPage` (added out-of-process, 2026-09-09).
 *
 * Reads `device.robotStatus` only (`wsMessages.ts`'s `RobotStatus`),
 * populated host-side from the most recent `status`/bare `estop` reply
 * on the endpoint's open session. The host polls `STATUS` on its own
 * every few seconds while a session is open, so this panel refreshes
 * itself with no timer of its own beyond the once-a-second "Last
 * updated Ns ago" tick below -- pressing this panel's own Refresh
 * button just requests one out-of-cadence update sooner, it is never
 * the only way this data moves.
 *
 * **Headline state word.** Derived from `robotStatus`'s booleans in a
 * fixed priority order (most urgent first): no `robotStatus` at all ->
 * "Unknown"; `estopped` -> "E-STOPPED"; `stallHalted` -> "Stall
 * halted"; `leaseExpired` -> "Lease expired"; `!ready` -> "Not ready";
 * `active` -> "Moving"; otherwise "Ready". Only one word is ever shown
 * -- this is a priority list, not several independent badges -- so a
 * board that is simultaneously `estopped` and `active` (a stale `active`
 * bit an e-stop hasn't cleared yet) reads as "E-STOPPED", the more
 * urgent fact.
 *
 * **Fields.** `robotStatus.fields` is every raw `k=v` pair the firmware
 * sent, verbatim, order-free (see `RobotStatus`'s own doc comment) --
 * rendered as a plain key/value list with no attempt to know the
 * firmware's field vocabulary ahead of time, mirroring `CommandStrip`'s
 * "no config field table lives in this project" discipline for
 * `GET`/`SET`.
 *
 * **Clear E-STOP.** Present only while `estopped` is `true`: sends `SET
 * estop_clear 1` (sequenced) followed immediately by a one-shot
 * `STATUS`, so this panel's own state reflects the clear without
 * waiting for the host's next poll tick. Mirrors `EstopControl`'s
 * identical button -- both exist because a student may reach for either
 * panel first; neither supersedes the other.
 *
 * **Deterministic "Last updated" text.** `receivedAt` is a host
 * `Date.now()` timestamp; the elapsed-seconds text is recomputed once a
 * second via an interval that only forces a re-render (the interval's
 * own tick value is never read). `now` is an injectable clock
 * (`() => number`, defaulting to `Date.now`) purely so tests can pin
 * down an exact "Ns ago" string instead of racing a real clock.
 */
import { useEffect, useRef, useState } from "react";
import type { EndpointListEntry, RobotStatus } from "@robot-console/host/src/wsMessages.js";
import { useWsActions } from "../ws/WsProvider";
import "./StatusPanel.css";

function stateWord(status: RobotStatus | undefined, linkOpen: boolean): string {
  if (!status) {
    return linkOpen ? "Unknown — asking the robot for its status…" : "Unknown — no link open";
  }
  if (status.estopped) {
    return "E-STOPPED";
  }
  if (status.stallHalted) {
    return "Stall halted";
  }
  if (status.leaseExpired) {
    return "Lease expired";
  }
  if (!status.ready) {
    return "Not ready";
  }
  if (status.active) {
    return "Moving";
  }
  return "Ready";
}

export interface StatusPanelProps {
  device: EndpointListEntry;
  /** Injectable clock for the "Last updated Ns ago" text -- tests only;
   * production always defaults to `Date.now`. */
  now?: () => number;
}

export function StatusPanel({ device, now = Date.now }: StatusPanelProps) {
  const endpointId = device.endpointId;
  const linkOpen = device.sessionOpen;
  const { sendCommand } = useWsActions();
  const status = device.robotStatus;

  // Forces one re-render per second so "Last updated Ns ago" stays
  // live -- the tick count itself is never read anywhere.
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  // OOP 2026-09-09: never sit on "Unknown" -- ask. The host polls STATUS
  // on its own once a robot identifies, but this panel also requests one
  // itself on mount (if the link is already open) and on every
  // closed->open transition, exactly as CommandStrip's discovery GET
  // does, so a freshly opened page shows a real state within one round
  // trip regardless of where the host's poll timer happens to be.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = linkOpen;
    if (linkOpen && !wasOpen) {
      sendCommand(endpointId, "STATUS");
    }
  }, [linkOpen, endpointId, sendCommand]);

  const word = stateWord(status, linkOpen);
  const isEstopped = status?.estopped === true;

  function handleRefresh(): void {
    sendCommand(endpointId, "STATUS");
  }

  function handleClearEstop(): void {
    sendCommand(endpointId, "SET", ["estop_clear", "1"]);
    sendCommand(endpointId, "STATUS");
  }

  return (
    // Deliberately not classed "status-panel" -- that class name belongs
    // to sprint 006's retired status-request panel, and
    // `RobotPage.test.tsx` guards against its reappearance
    // (`el.querySelector(".status-panel")` must stay null). This
    // component's own class is "robot-status-panel"; every inner class
    // below is still prefixed "status-panel-*" purely for local naming
    // consistency and does not collide (a CSS class selector matches
    // whole tokens, not prefixes).
    <section className="robot-status-panel" aria-label="Robot status">
      <p
        className={`status-panel-state${isEstopped ? " status-panel-state-danger" : ""}`}
        data-testid="status-panel-state"
      >
        {word}
      </p>

      {status && (
        <>
          <dl className="status-panel-fields" data-testid="status-panel-fields">
            {Object.entries(status.fields).map(([key, value]) => (
              <div className="status-panel-field" key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <p className="status-panel-updated">
            Last updated {Math.max(0, Math.floor((now() - status.receivedAt) / 1000))}s ago
          </p>
        </>
      )}

      <div className="status-panel-actions">
        <button
          type="button"
          className="status-panel-button"
          data-testid="status-panel-refresh"
          disabled={!linkOpen}
          onClick={handleRefresh}
        >
          Refresh
        </button>
        {isEstopped && (
          <button
            type="button"
            className="status-panel-button status-panel-button-danger"
            data-testid="status-panel-clear-estop"
            disabled={!linkOpen}
            onClick={handleClearEstop}
          >
            Clear E-STOP
          </button>
        )}
      </div>
    </section>
  );
}
