/**
 * CommandStrip.tsx — the robot page's unsequenced-verb toolbar plus a
 * free-text GET/SET pair, mounted beneath `DeviceConsole` in
 * `RobotPage`'s right column (ticket 005 / SUC-006, SUC-007).
 *
 * Replaces sprint 006's separate status-request panel and Get/Set
 * panel, both retired this ticket. The key difference from those two
 * panels is not what gets sent -- it is what happens to the reply:
 * neither survives, and this component renders **no reply area of its
 * own**. Every reply this strip's buttons provoke is an ordinary `line`
 * message (or, for `HELLO`'s refusal, a host `error` message) that
 * lands in the same per-endpoint log `DeviceConsole` already renders --
 * see `sprint.md`'s Design Rationale, "no separate response areas, all
 * replies land in the one console log". The retired Get/Set panel's
 * `-1`-initial-watermark bug (a filter that matched the endpoint's
 * entire rx history before anything was ever sent) has no analogue
 * here, structurally: there is nothing here to filter, because there is
 * no local reply state at all.
 *
 * **Dispatch, verb by verb:**
 *  - `HELLO`/`ID`/`VER`/`STATUS` are not in `SEQUENCED_VERBS`
 *    (`@robot-console/protocol`'s `v6/session.ts:120-132`), so all four
 *    go through plain `sendCommand(endpointId, verb)` with no fields --
 *    the same unsequenced path `EstopControl` and the old status-request
 *    panel already used. **`HELLO` is not special-cased on the client.** It
 *    is sent exactly like the other three; `deviceRegistry.ts:945-951`
 *    deliberately intercepts a live `"HELLO"` *host-side*, before it
 *    ever reaches `Session`, and reports the refusal via a `type:
 *    "error"` message carrying this endpoint's id (a deliberate,
 *    unchanged sprint 006 safety rule -- `HELLO` resets the robot's
 *    sequence state). Ticket 012-003 is what makes that refusal land in
 *    `DeviceConsole`'s log instead of being silently dropped; this
 *    ticket's only job is to send the command and let that existing
 *    pipe carry the answer.
 *  - `GET`/`SET` remain sequenced (`SEQUENCED_VERBS`), dispatched the
 *    same way the retired Get/Set panel did: bare `GET` (no fields)
 *    when the name field is empty, `GET <name>` when a name is entered,
 *    `SET <name> <value>` when both are entered. `sendCommand` itself
 *    decides sequenced vs. unsequenced dispatch host-side
 *    (`isSequencedVerb`); this component never re-derives that
 *    classification.
 *
 * **Field-name auto-discovery is ticket 006, not this one.** The name
 * field here is a plain free-text `<input>`, matching the retired
 * Get/Set panel's own documented reasoning: `protocol.md` holds no
 * config field table, so there is no enumerable list of legal
 * `GET`/`SET` names to build a picker from without inventing vocabulary
 * the firmware never promised.
 */
import { useState } from "react";
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { useWsActions } from "../ws/WsProvider";
import "./CommandStrip.css";

export interface CommandStripProps {
  device: EndpointListEntry;
}

export function CommandStrip({ device }: CommandStripProps) {
  const endpointId = device.endpointId;
  const linkOpen = device.sessionOpen;
  const { sendCommand } = useWsActions();

  const [nameDraft, setNameDraft] = useState("");
  const [valueDraft, setValueDraft] = useState("");

  function handleGet(): void {
    if (!linkOpen) {
      return;
    }
    const name = nameDraft.trim();
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
    sendCommand(endpointId, "SET", [name, value]);
  }

  return (
    <section className="command-strip" aria-label="Command strip">
      {!linkOpen && (
        <p className="command-strip-hint" role="status">
          No link open — open a link before sending commands.
        </p>
      )}

      <div className="command-strip-buttons">
        <button
          type="button"
          className="command-strip-button"
          data-testid="command-strip-hello"
          disabled={!linkOpen}
          onClick={() => sendCommand(endpointId, "HELLO")}
        >
          HELLO
        </button>
        <button
          type="button"
          className="command-strip-button"
          data-testid="command-strip-id"
          disabled={!linkOpen}
          onClick={() => sendCommand(endpointId, "ID")}
        >
          ID
        </button>
        <button
          type="button"
          className="command-strip-button"
          data-testid="command-strip-ver"
          disabled={!linkOpen}
          onClick={() => sendCommand(endpointId, "VER")}
        >
          VER
        </button>
        <button
          type="button"
          className="command-strip-button"
          data-testid="command-strip-status"
          disabled={!linkOpen}
          onClick={() => sendCommand(endpointId, "STATUS")}
        >
          STATUS
        </button>
      </div>

      <form
        className="command-strip-form"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <label className="command-strip-field">
          <span>Name</span>
          <input
            type="text"
            data-testid="command-strip-name"
            value={nameDraft}
            onChange={(event) => setNameDraft(event.target.value)}
            placeholder="(empty = every field)"
            disabled={!linkOpen}
          />
        </label>
        <label className="command-strip-field">
          <span>Value</span>
          <input
            type="text"
            data-testid="command-strip-value"
            value={valueDraft}
            onChange={(event) => setValueDraft(event.target.value)}
            disabled={!linkOpen}
          />
        </label>
        <div className="command-strip-buttons">
          <button
            type="button"
            className="command-strip-button"
            data-testid="command-strip-get"
            disabled={!linkOpen}
            onClick={handleGet}
          >
            GET
          </button>
          <button
            type="button"
            className="command-strip-button"
            data-testid="command-strip-set"
            disabled={!linkOpen || nameDraft.trim().length === 0 || valueDraft.trim().length === 0}
            onClick={handleSet}
          >
            SET
          </button>
        </div>
      </form>
    </section>
  );
}
