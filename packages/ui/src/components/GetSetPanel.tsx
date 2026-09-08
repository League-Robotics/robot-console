/**
 * GetSetPanel.tsx — raw `GET`/`SET` verb access (ticket 005 / SUC-001,
 * SUC-004).
 *
 * A free-text name/value form, not a dropdown of named presets --
 * per protocol.md, "no config field table lives in this library", so
 * there is no enumerable list of legal `GET`/`SET` names this UI could
 * build a picker from without inventing vocabulary the firmware never
 * promised. The team-lead decision (see `sprint.md`) is to revisit this
 * once calibration (sprint 10) gives the fields real meaning.
 *
 * `GET` sends `GET <name>` when a name is entered, or bare `GET` (no
 * fields at all) when the name field is empty -- per protocol.md, a
 * bare `GET` returns one `get` line per known field. `SET` sends
 * `SET <name> <value>`. Both are sequenced (`isSequencedVerb`), so
 * their outcome eventually surfaces as an `ack`/`nack` line, in
 * addition to any `get ...`/`err ...` lines the firmware sends first --
 * every one of those arrives as an ordinary `line` message, exactly
 * like `StatusPanel`'s reply.
 *
 * Reply display: rather than re-parsing a wire grammar this library
 * deliberately does not fix (`v6/codec.ts`'s "no verb table"
 * discipline), this panel just watches the endpoint's log for whatever
 * arrives *after* the most recent `GET`/`SET` was sent, and shows those
 * lines verbatim -- so a `get name value` line, a bare `ack`, or an
 * `err <code> ...` reply for an unknown name are all shown as-is,
 * never swallowed. Lines that read as an error (`err`/`nack`, mirroring
 * `DeviceConsole.classifyLine`'s own pattern) get an error style.
 */
import { useState } from "react";
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { useEndpointLog, useWsActions } from "../ws/WsProvider";
import "./GetSetPanel.css";

const ERROR_REPLY_PATTERN = /^(err|nack)\b/i;

export interface GetSetPanelProps {
  device: EndpointListEntry;
}

export function GetSetPanel({ device }: GetSetPanelProps) {
  const endpointId = device.endpointId;
  const { sendCommand } = useWsActions();
  const log = useEndpointLog(endpointId);

  const [nameDraft, setNameDraft] = useState("");
  const [valueDraft, setValueDraft] = useState("");
  // The highest log entry id present at the moment of the most recent
  // GET/SET send -- everything after this watermark (on the rx side)
  // is "the reply" to that send. `-1` (before any log entry could
  // ever exist) is the initial "nothing sent yet" value.
  const [watermarkId, setWatermarkId] = useState(-1);

  const linkOpen = device.sessionOpen;
  const replies = log.filter((entry) => entry.direction === "rx" && entry.id > watermarkId);

  function markWatermark(): void {
    const last = log[log.length - 1];
    setWatermarkId(last ? last.id : -1);
  }

  function handleGet(): void {
    if (!linkOpen) {
      return;
    }
    const name = nameDraft.trim();
    markWatermark();
    if (name.length > 0) {
      sendCommand(endpointId, "GET", [name]);
    } else {
      sendCommand(endpointId, "GET");
    }
  }

  function handleSet(): void {
    if (!linkOpen) {
      return;
    }
    const name = nameDraft.trim();
    const value = valueDraft.trim();
    if (name.length === 0 || value.length === 0) {
      return;
    }
    markWatermark();
    sendCommand(endpointId, "SET", [name, value]);
  }

  return (
    <section className="get-set-panel" aria-label="Get/Set">
      {!linkOpen && (
        <p className="get-set-panel-hint" role="status">
          No link open — open a link before sending GET/SET.
        </p>
      )}
      <form
        className="get-set-panel-form"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <label className="get-set-panel-field">
          <span>Name</span>
          <input
            type="text"
            data-testid="get-set-name"
            value={nameDraft}
            onChange={(event) => setNameDraft(event.target.value)}
            placeholder="(empty = every field)"
            disabled={!linkOpen}
          />
        </label>
        <label className="get-set-panel-field">
          <span>Value</span>
          <input
            type="text"
            data-testid="get-set-value"
            value={valueDraft}
            onChange={(event) => setValueDraft(event.target.value)}
            disabled={!linkOpen}
          />
        </label>
        <div className="get-set-panel-buttons">
          <button
            type="button"
            className="get-set-panel-button"
            data-testid="get-set-get-button"
            disabled={!linkOpen}
            onClick={handleGet}
          >
            GET
          </button>
          <button
            type="button"
            className="get-set-panel-button"
            data-testid="get-set-set-button"
            disabled={!linkOpen || nameDraft.trim().length === 0 || valueDraft.trim().length === 0}
            onClick={handleSet}
          >
            SET
          </button>
        </div>
      </form>

      <div className="get-set-panel-replies" data-testid="get-set-replies">
        {replies.length === 0 ? (
          <p className="get-set-panel-replies-empty">No reply yet.</p>
        ) : (
          replies.map((entry) => (
            <p
              key={entry.id}
              className={
                ERROR_REPLY_PATTERN.test(entry.line.trimStart())
                  ? "get-set-panel-reply-line get-set-panel-reply-error"
                  : "get-set-panel-reply-line"
              }
            >
              {entry.line}
            </p>
          ))
        )}
      </div>
    </section>
  );
}
