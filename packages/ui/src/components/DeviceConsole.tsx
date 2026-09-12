/**
 * DeviceConsole.tsx — the raw line console (SUC-002/SUC-007), sprint
 * 4's successor to `ConsoleTab.tsx`.
 *
 * Embedded per-device on every per-device page (unknown/relay/robot)
 * rather than promoted to its own nested route (`/d/:linkId/console`)
 * this sprint -- see `sprint.md`'s Design Rationale entry "Raw console
 * embedded per-device (`DeviceConsole.tsx`) rather than a nested route"
 * for why: the raw line console has no drive/telemetry dependency, so
 * it can ship now without pulling forward sprint 6/8's route work, and
 * a later sprint can promote it to a nested route with no reshape of
 * the underlying per-link log store (`WsProvider`'s `logsByLink`,
 * hoisted above the router for exactly this reason).
 *
 * Scoped to exactly one `linkId` -- no device-picker dropdown, since the
 * route already picked the device (`DevicePage`'s per-type dispatch,
 * ticket 008). The link itself arrives as a prop (the caller already
 * holds it via `useLink`/`DevicePage`'s dispatch, or (`RelayPage`) the
 * child link it found in the snapshot) rather than this component
 * subscribing to it a second time. Otherwise preserves every behavior
 * `ConsoleTab.tsx` had: classification styling (comment/debug/error/ack/
 * data), autoscroll toggle, clear log, send box with cooldown, the "some
 * commands get no reply" note, and the "open a link first" hint when no
 * session is open. The connection-status banner `ConsoleTab.tsx` also
 * rendered is not carried forward -- it was a whole-list concern
 * (echoed identically by the old Devices tab), and every per-device page
 * here already gates on `WsProvider`'s `hasSnapshot`/link presence
 * before this component is ever mounted (`DevicePage.tsx`).
 *
 * ## Sprint 015 ticket 008: takes a `SnapshotLink`, not an `EndpointListEntry`
 *
 * `link.session !== undefined` replaces the retired `sessionOpen` flag
 * (see `wsMessages.ts`'s own doc comment: presence/absence of `session`
 * *is* the open/closed distinction now, so there is no separate boolean
 * to keep in sync with it); `useLinkLog`/`clearLinkLog` replace
 * `useEndpointLog`/`clearEndpointLog` (renamed, ticket 007); every
 * outgoing message keys on `linkId` instead of `endpointId`
 * (`wsMessages.ts`'s sprint 015 reshape). `deviceLabel` is gone --
 * `SnapshotDevice.name` is always a resolved string and an `unassigned`
 * link has no name at all to guess at, so the caller now passes the
 * label to show (`name`), rather than this component re-deriving a
 * "Naming…"/"Unnamed device" fallback from fields that no longer exist
 * on a link.
 *
 * Ticket 012-003: a host `type: "notice"` message scoped to this link
 * (routed into its log by `WsProvider`'s `appendNotice`, as a `LogEntry`
 * with `origin: "host"`) renders here with the same "error" kind styling
 * as a device-sent `err`/`nack` line, forced regardless of the message
 * text -- see the render loop below and `LogEntry`'s own doc comment.
 *
 * **Poll traffic hidden by default (added out-of-process, 2026-09-09).**
 * A `LogEntry` with `origin: "poll"` (the host's own periodic `STATUS`
 * poll against an open robot session) is filtered out of what this
 * component renders unless the "Show status polls" toggle
 * (`data-testid="console-show-polls"`) is checked. This is
 * presentation-only: every poll line the host forwards is still
 * appended to `WsProvider`'s store and counted against
 * `MAX_LINES_PER_LINK` exactly like any other line. Toggling the
 * checkbox never re-sends anything and never mutates the store; it only
 * changes which already-retained entries this render pass includes. A
 * shown poll line gets the `console-line-origin-poll` class
 * (`DeviceConsole.css`) so it reads as muted/secondary next to ordinary
 * traffic once revealed.
 *
 * ## Sprint 015 ticket 009: gates on the host connection too
 *
 * The send box and the "open a link" hint's own button now also gate on
 * `useSendable()` (socket open, snapshot not stale), not just this
 * link's own `session` field -- a link's `session` survives a reconnect
 * in the last-known snapshot, so it alone cannot distinguish "still
 * connected" from "what we had before we lost the host" (UC-020,
 * `no-disconnected-from-host-banner-in-the-ui.md`).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { MAX_LINES_PER_LINK, useLinkLog, useSendable, useWsActions } from "../ws/WsProvider";
import { classifyLine } from "../lib/lineClass";
import { SequencingIndicator } from "./SequencingIndicator";
import "./DeviceConsole.css";

/** How long the send box stays disabled after a submit. A simple
 * client-side pacing nicety, not the correctness mechanism -- the
 * host's own pacing budget is what actually protects the device; this
 * just keeps a student from firing unpaced writes by mashing Enter. */
const SEND_COOLDOWN_MS = 250;

export interface DeviceConsoleProps {
  link: SnapshotLink;
  /** Display label for the "No link open to …" hint -- the caller
   * already knows the best name to show (a device's own resolved name,
   * or the link's own `label` for an `unassigned` board with no device
   * yet), so this component no longer guesses one from fields that only
   * ever lived on the retired `EndpointListEntry`. */
  name: string;
}

export function DeviceConsole({ link, name }: DeviceConsoleProps) {
  const linkId = link.id;
  const { send, clearLinkLog } = useWsActions();
  const [autoScroll, setAutoScroll] = useState(true);
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState("");
  const [showPolls, setShowPolls] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // The log buffer lives in `WsProvider`'s store, subscribed
  // independently of which page is currently mounted -- so navigating
  // away and back never drops a line (SUC-007).
  const log = useLinkLog(linkId);

  // Presentation-only filter -- every entry stays in `WsProvider`'s
  // store regardless of `showPolls`; see this module's doc comment.
  const visibleLog = showPolls ? log : log.filter((entry) => entry.origin !== "poll");

  useEffect(() => {
    return () => {
      if (cooldownTimer.current) {
        clearTimeout(cooldownTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [visibleLog, autoScroll]);

  // Ticket 009 / UC-020: a link's own `session` field survives a
  // reconnect in the last-known snapshot, so this component's send box
  // and "open a link" hint also gate on the host connection itself
  // being sendable, not just this link's own session state -- see
  // `useSendable`'s own doc comment.
  const sendable = useSendable();
  const linkOpen = link.session !== undefined && sendable;
  const sendDisabled = !linkOpen || pending;

  const submitLine = useCallback(() => {
    if (!linkOpen || pending) {
      return;
    }
    const line = draft;
    if (line.length === 0) {
      return;
    }
    send({ type: "line", linkId, direction: "tx", line });
    setDraft("");
    setPending(true);
    cooldownTimer.current = setTimeout(() => setPending(false), SEND_COOLDOWN_MS);
  }, [linkId, linkOpen, pending, draft, send]);

  const clearLog = () => {
    clearLinkLog(linkId);
  };

  const openLink = () => {
    send({ type: "session-open", linkId });
  };

  return (
    <section className="device-console" aria-label="Console">
      <div className="console-toolbar">
        <button type="button" className="console-button" onClick={() => setAutoScroll((v) => !v)}>
          {autoScroll ? "Pause autoscroll" : "Resume autoscroll"}
        </button>
        <button
          type="button"
          className="console-button"
          onClick={clearLog}
          disabled={log.length === 0}
        >
          Clear log
        </button>
        <label className="console-toggle">
          <input
            type="checkbox"
            data-testid="console-show-polls"
            checked={showPolls}
            onChange={(event) => setShowPolls(event.target.checked)}
          />
          Show status polls
        </label>
      </div>

      {!linkOpen && (
        <p className="console-hint" role="status">
          No link open to {name} —{" "}
          <button type="button" className="console-link-button" disabled={!sendable} onClick={openLink}>
            open a link
          </button>{" "}
          before sending.
        </p>
      )}

      {/* OOP 2026-09-10: sequencing state sits at the top of the log
          (stakeholder direction), not in its own page panel. */}
      <SequencingIndicator session={link.session} />
      <div className="console-log" ref={logRef} data-testid="console-log">
        {visibleLog.length === 0 ? (
          <p className="console-log-empty">
            No traffic yet for this device. Send a line below, or wait for the device to speak
            first.
          </p>
        ) : (
          visibleLog.map((entry) => {
            // `entry.origin === "host"` (ticket 012-003: a host
            // `type: "notice"` message routed into this link's log)
            // forces the existing "error" kind styling instead of
            // running it through `classifyLine`'s text sniffing -- a
            // host notice's wording ("no open link", ...) does not
            // necessarily start with "err"/"nack", so leaving this to
            // `classifyLine` would silently misclassify most of them as
            // ordinary `data` and make them indistinguishable from a
            // line the device itself sent.
            const kind = entry.origin === "host" ? "error" : classifyLine(entry.line);
            const isPoll = entry.origin === "poll";
            return (
              <div
                key={entry.id}
                className={`console-line console-line-${entry.direction} console-line-kind-${kind}${
                  isPoll ? " console-line-origin-poll" : ""
                }`}
                data-testid={`console-line-${entry.direction}`}
                data-host-error={entry.origin === "host" ? "true" : undefined}
                data-origin-poll={isPoll ? "true" : undefined}
              >
                <span className="console-line-direction" aria-hidden="true">
                  {entry.origin === "host" ? "⚠" : entry.direction === "tx" ? "»" : "«"}
                </span>
                <span className="console-line-text">{entry.line}</span>
              </div>
            );
          })
        )}
      </div>


      <form
        className="console-send"
        onSubmit={(event) => {
          event.preventDefault();
          submitLine();
        }}
      >
        <input
          type="text"
          className="console-send-input"
          data-testid="console-send-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={!linkOpen ? "Open a link to this device first" : "Type a line and press Enter…"}
          disabled={sendDisabled}
          aria-label="Line to send"
        />
        <button
          type="submit"
          className="console-button console-button-primary"
          data-testid="console-send-button"
          disabled={sendDisabled || draft.length === 0}
        >
          Send
        </button>
      </form>
    </section>
  );
}
