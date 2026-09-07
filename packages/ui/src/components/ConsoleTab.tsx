/**
 * ConsoleTab.tsx — the Console tab (SUC-002).
 *
 * A generic, raw line console for one selected device: a scrolling log
 * of everything the host forwarded over `WsProvider`'s shared
 * WebSocket (both directions -- see below), plus a send box. Per
 * `sprint.md` / `specification.md` §5 this is deliberately the one
 * place raw protocol traffic is exposed, unlike the guided-flow style
 * used elsewhere in the UI -- not an inconsistency to smooth over.
 *
 * Scope discipline (per the ticket): type anything, see the reply.
 * No `WHEELS_X`/`WHEELS_V`/motor-control-specific widgets -- that is a
 * later sprint's UC-003.
 *
 * Line provenance: a sent (`tx`) line is *not* echoed into the log
 * locally on submit. `deviceRegistry.ts` re-emits every line it writes
 * to a device back out over `onLine` with `direction: "tx"`
 * (`emitLine(deviceId, "tx", line)`), and `server.ts` broadcasts that
 * like any other line message -- so the log is built entirely from
 * inbound `type: "line"` WebSocket messages, in both directions. That
 * is what keeps this tab's acceptance criterion true: it shows only
 * lines the host actually forwarded, with no client-side re-filtering
 * that could disagree with the host's own foreign-traffic-drop
 * decision (ticket 004's codec classification already dropped
 * anything else before it reached the WebSocket).
 *
 * Silent-device legibility: the common first experience with the
 * ground-truth board is sending a line and getting zero bytes back.
 * The UI must not make that look broken or hanging -- the sent line
 * still appears in the log (once the host's own tx-echo arrives) and
 * the send box re-enables promptly, so "sent, nothing came back yet"
 * reads as normal, not stuck. A note under the log says this in plain
 * language for a non-technical reader.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import {
  MAX_LINES_PER_DEVICE,
  useConnectionStatus,
  useEndpointLog,
  useEndpoints,
  useWsActions,
} from "../ws/WsProvider";
import "./ConsoleTab.css";

// Re-exported so existing call sites/tests (`MAX_LINES_PER_DEVICE` was
// this module's own constant pre-ticket-006) keep working now that the
// cap lives with the hoisted log buffer in `WsProvider.tsx`.
export { MAX_LINES_PER_DEVICE };

/** How long the send box stays disabled after a submit. A simple
 * client-side pacing nicety, not the correctness mechanism -- the
 * host's own pacing budget (ticket 008) is what actually protects the
 * device; this just keeps a student from firing unpaced writes by
 * mashing Enter. */
const SEND_COOLDOWN_MS = 250;

type LineKind = "comment" | "debug" | "error" | "ack" | "data";

/** Presentation-only classification of a raw line, per the ticket's
 * "worth reflecting in the display" list. This never hides or filters
 * a line -- every line the host forwarded is still shown -- it only
 * picks which style class to draw it with. */
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

export function ConsoleTab() {
  const status = useConnectionStatus();
  const devices = useEndpoints();
  const { send, clearEndpointLog } = useWsActions();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState("");
  const logRef = useRef<HTMLDivElement | null>(null);
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // The log buffer itself lives in `WsProvider`'s store (ticket 006),
  // subscribed once there independent of which device is selected here
  // -- so switching the picker never drops a line that arrived while a
  // different device was in view. `""` is not a real `endpointId`, so
  // this resolves to the store's shared empty-log value before a device
  // is selected -- `useEndpointLog` must still be called unconditionally
  // per the rules of hooks.
  const log = useEndpointLog(selectedId ?? "");

  // Default to the first known device once the list arrives. Sticky
  // afterwards -- never yanks the student to a different device just
  // because the list re-orders or a new device appears.
  useEffect(() => {
    const first = devices[0];
    if (selectedId === null && first) {
      setSelectedId(first.endpointId);
    }
  }, [selectedId, devices]);

  useEffect(() => {
    return () => {
      if (cooldownTimer.current) {
        clearTimeout(cooldownTimer.current);
      }
    };
  }, []);

  const selectedDevice = devices.find((device) => device.endpointId === selectedId) ?? null;

  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [log, autoScroll]);

  const linkOpen = selectedDevice?.sessionOpen ?? false;
  const sendDisabled = status !== "open" || !selectedId || !linkOpen || pending;

  const submitLine = useCallback(() => {
    if (!selectedId || !linkOpen || pending) {
      return;
    }
    const line = draft;
    if (line.length === 0) {
      return;
    }
    send({ type: "line", endpointId: selectedId, direction: "tx", line });
    setDraft("");
    setPending(true);
    cooldownTimer.current = setTimeout(() => setPending(false), SEND_COOLDOWN_MS);
  }, [selectedId, linkOpen, pending, draft, send]);

  const clearLog = () => {
    if (!selectedId) {
      return;
    }
    clearEndpointLog(selectedId);
  };

  const openLink = () => {
    if (selectedId) {
      send({ type: "session-open", endpointId: selectedId });
    }
  };

  return (
    <section className="console-tab" aria-label="Console">
      {status !== "open" && (
        <p className="connection-banner" role="status">
          {status === "connecting"
            ? "Connecting to robot-console…"
            : "Lost connection to robot-console — reconnecting…"}
        </p>
      )}

      <div className="console-toolbar">
        <label className="console-device-picker">
          <span>Device</span>
          <select
            data-testid="console-device-select"
            value={selectedId ?? ""}
            onChange={(event) => setSelectedId(event.target.value || null)}
            disabled={devices.length === 0}
          >
            {devices.length === 0 && <option value="">No devices</option>}
            {devices.map((device) => (
              <option key={device.endpointId} value={device.endpointId}>
                {deviceLabel(device)}
                {device.role ? ` — ${device.role}` : ""}
              </option>
            ))}
          </select>
        </label>

        <button type="button" className="console-button" onClick={() => setAutoScroll((v) => !v)}>
          {autoScroll ? "Pause autoscroll" : "Resume autoscroll"}
        </button>
        <button
          type="button"
          className="console-button"
          onClick={clearLog}
          disabled={!selectedId || log.length === 0}
        >
          Clear log
        </button>
      </div>

      {selectedDevice && !selectedDevice.sessionOpen && (
        <p className="console-hint" role="status">
          No link open to {deviceLabel(selectedDevice)} —{" "}
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
            const kind = classifyLine(entry.line);
            return (
              <div
                key={entry.id}
                className={`console-line console-line-${entry.direction} console-line-kind-${kind}`}
                data-testid={`console-line-${entry.direction}`}
              >
                <span className="console-line-direction" aria-hidden="true">
                  {entry.direction === "tx" ? "»" : "«"}
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
          placeholder={
            !selectedId
              ? "Select a device first"
              : !linkOpen
                ? "Open a link to this device first"
                : "Type a line and press Enter…"
          }
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
