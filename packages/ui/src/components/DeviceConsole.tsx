/**
 * DeviceConsole.tsx — the raw line console (SUC-002/SUC-007), sprint
 * 4's successor to `ConsoleTab.tsx`.
 *
 * Embedded per-device on every per-device page (unknown/relay/robot)
 * rather than promoted to its own nested route (`/d/:endpointId/console`)
 * this sprint -- see `sprint.md`'s Design Rationale entry "Raw console
 * embedded per-device (`DeviceConsole.tsx`) rather than a nested route"
 * for why: the raw line console has no drive/telemetry dependency, so
 * it can ship now without pulling forward sprint 6/8's route work, and
 * a later sprint can promote it to a nested route with no reshape of
 * the underlying per-endpoint log store (`WsProvider`'s
 * `logsByEndpoint`, hoisted above the router in ticket 006 for exactly
 * this reason). A future reader tempted to add the nested route before
 * then should read that Design Rationale entry first, not re-litigate
 * the decision from scratch.
 *
 * Scoped to exactly one `endpointId` -- no device-picker dropdown, since
 * the route already picked the device (`DevicePage`'s per-type
 * dispatch, ticket 008). The endpoint itself arrives as a prop (the
 * caller already holds it via `useEndpoint`/`DevicePage`'s dispatch)
 * rather than this component subscribing to it a second time.
 * Otherwise preserves every behavior `ConsoleTab.tsx` had: classification
 * styling (comment/debug/error/ack/data), autoscroll toggle, clear log,
 * send box with cooldown, the "some commands get no reply" note, and
 * the "open a link first" hint when `sessionOpen` is false. The
 * connection-status banner `ConsoleTab.tsx` also rendered is not
 * carried forward -- it was a whole-list concern (echoed identically by
 * the old Devices tab), and every per-device page here already gates
 * on `WsProvider`'s `hasSnapshot`/`endpoint` presence before this
 * component is ever mounted (`DevicePage.tsx`).
 *
 * Ticket 012-003: a host `type: "error"` message (routed into this
 * endpoint's log by `WsProvider`'s `appendHostError`, as a `LogEntry`
 * with `origin: "host"`) renders here with the same "error" kind
 * styling as a device-sent `err`/`nack` line, forced regardless of the
 * message text -- see the render loop below and `LogEntry`'s own doc
 * comment.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { MAX_LINES_PER_DEVICE, useEndpointLog, useWsActions } from "../ws/WsProvider";
import "./DeviceConsole.css";

/** How long the send box stays disabled after a submit. A simple
 * client-side pacing nicety, not the correctness mechanism -- the
 * host's own pacing budget is what actually protects the device; this
 * just keeps a student from firing unpaced writes by mashing Enter. */
const SEND_COOLDOWN_MS = 250;

type LineKind = "comment" | "debug" | "error" | "ack" | "data";

/** Presentation-only classification of a raw line, per `ConsoleTab.tsx`'s
 * original "worth reflecting in the display" list. This never hides or
 * filters a line -- every line the host forwarded is still shown -- it
 * only picks which style class to draw it with. */
export function classifyLine(line: string): LineKind {
  const text = line.trimStart();
  if (text.startsWith("#")) {
    return "comment";
  }
  if (text.startsWith("DBG:")) {
    return "debug";
  }
  if (/^(err|nack)\b/i.test(text)) {
    return "error";
  }
  if (/^ack\b/i.test(text)) {
    return "ack";
  }
  return "data";
}

function deviceLabel(device: EndpointListEntry): string {
  if (device.name) {
    return device.name;
  }
  if (device.nameError) {
    return "Unnamed device";
  }
  return "Naming…";
}

export interface DeviceConsoleProps {
  device: EndpointListEntry;
}

export function DeviceConsole({ device }: DeviceConsoleProps) {
  const endpointId = device.endpointId;
  const { send, clearEndpointLog } = useWsActions();
  const [autoScroll, setAutoScroll] = useState(true);
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState("");
  const logRef = useRef<HTMLDivElement | null>(null);
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // The log buffer lives in `WsProvider`'s store (ticket 006),
  // subscribed independently of which page is currently mounted -- so
  // navigating away and back never drops a line (SUC-007).
  const log = useEndpointLog(endpointId);

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
  }, [log, autoScroll]);

  const linkOpen = device.sessionOpen;
  const sendDisabled = !linkOpen || pending;

  const submitLine = useCallback(() => {
    if (!linkOpen || pending) {
      return;
    }
    const line = draft;
    if (line.length === 0) {
      return;
    }
    send({ type: "line", endpointId, direction: "tx", line });
    setDraft("");
    setPending(true);
    cooldownTimer.current = setTimeout(() => setPending(false), SEND_COOLDOWN_MS);
  }, [endpointId, linkOpen, pending, draft, send]);

  const clearLog = () => {
    clearEndpointLog(endpointId);
  };

  const openLink = () => {
    send({ type: "session-open", endpointId });
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
      </div>

      {!linkOpen && (
        <p className="console-hint" role="status">
          No link open to {deviceLabel(device)} —{" "}
          <button type="button" className="console-link-button" onClick={openLink}>
            open a link
          </button>{" "}
          before sending.
        </p>
      )}

      <div className="console-log" ref={logRef} data-testid="console-log">
        {log.length === 0 ? (
          <p className="console-log-empty">
            No traffic yet for this device. Send a line below, or wait for the device to speak
            first.
          </p>
        ) : (
          log.map((entry) => {
            // `entry.origin === "host"` (ticket 012-003: a host
            // `type: "error"` message routed into this log) forces the
            // existing "error" kind styling instead of running it
            // through `classifyLine`'s text sniffing -- a host error's
            // wording ("no open link", the "HELLO" refusal, ...) does
            // not necessarily start with "err"/"nack", so leaving this
            // to `classifyLine` would silently misclassify most of them
            // as ordinary `data` and make them indistinguishable from a
            // line the device itself sent.
            const kind = entry.origin === "host" ? "error" : classifyLine(entry.line);
            return (
              <div
                key={entry.id}
                className={`console-line console-line-${entry.direction} console-line-kind-${kind}`}
                data-testid={`console-line-${entry.direction}`}
                data-host-error={entry.origin === "host" ? "true" : undefined}
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

      <p className="console-log-note">
        Showing up to {MAX_LINES_PER_DEVICE} lines for this device. » = sent by you, « = received
        from the device. Some commands get no reply at all on some boards — that is normal, not a
        stuck connection.
      </p>

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
