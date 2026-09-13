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
 *    go through plain `sendCommand(linkId, verb)` with no fields --
 *    the same unsequenced path `EstopControl` and the old status-request
 *    panel already used. **`HELLO` is not special-cased on the client.**
 *    It is sent exactly like the other three; `deviceRegistry.ts`'s
 *    `sendCommand` deliberately intercepts a live `"HELLO"` *host-side*,
 *    before it ever reaches `Session`, and routes it through
 *    `resyncSession` -- the disciplined resync path (`Link.identify()`,
 *    which sends `HELLO` and resets this session's own sequencing state
 *    to match) rather than the flat refusal an earlier sprint shipped.
 *    A resync that gets no reply still reports a `type: "error"` message
 *    carrying this endpoint's id, landing in `DeviceConsole`'s log the
 *    same way that refusal used to; this component's only job is to
 *    send the command and let that existing pipe carry the answer.
 *  - `GET`/`SET` remain sequenced (`SEQUENCED_VERBS`), dispatched the
 *    same way the retired Get/Set panel did: bare `GET` (no fields)
 *    when the name field is empty, `GET <name>` when a name is entered,
 *    `SET <name> <value>` when both are entered. `sendCommand` itself
 *    decides sequenced vs. unsequenced dispatch host-side
 *    (`isSequencedVerb`); this component never re-derives that
 *    classification.
 *
 * **Field-name auto-discovery (ticket 006, SUC-007).** The codebase has
 * no enumerable list of legal `GET`/`SET` field names to build a picker
 * from -- per protocol.md, "no config field table lives in this
 * library", and the vocabulary is owned by whatever firmware build is
 * on the device, not by this project. The one mechanism protocol.md
 * does promise: a bare `GET` (no name) returns one `get <name> <value>`
 * line per known field.
 *
 * `get <name> <value>` reply lines are harvested with the same "loose
 * prefix match, no invented grammar" discipline `classifyLine` and the
 * retired Get/Set panel's `ERROR_REPLY_PATTERN` used -- `GET_REPLY_PATTERN`
 * below only pulls the first token after `get`, so an unrecognized or
 * unexpected reply shape is silently ignored (harvested as nothing new)
 * rather than treated as an error. Discovered names populate the name
 * field's `<datalist>`, making it an editable combo box -- **never a
 * closed `<select>`** -- so a field the device didn't report (or
 * hasn't reported yet) can still be typed and sent via GET or SET.
 * Host `type: "notice"` log entries (`origin: "host"`) are excluded from
 * harvesting; they are not device-sourced `get` replies.
 *
 * ## Sprint 015 ticket 009: no on-open discovery probe any more
 *
 * Before this ticket, this component fired its own bare `GET` on mount
 * (if a session was already open) and again on every closed->open
 * transition, so the discovered-names `<datalist>` populated itself
 * without a person pressing GET first. That probe is deleted outright,
 * not adapted: the harvester (ticket 003) does not send a `GET` of its
 * own on identify (only `ID` once, plus the `STATUS` poll), so there is
 * no snapshot-side equivalent to read discovered field names from --
 * this component now only harvests names from `get <name> <value>` lines
 * already in the link's log (from an earlier manual GET/SET, in this
 * session or carried over from before a reconnect), never fires one on
 * its own. A student who wants the combo box populated presses GET (with
 * an empty name) once, same as always; nothing here retries on their
 * behalf any more.
 *
 * **FUNCS (added out-of-process, 2026-09-09).** A `FUNCS` button sits
 * after `STATUS`, sending the bare verb with no fields via the same
 * plain `sendCommand` path as `HELLO`/`ID`/`VER`/`STATUS` -- `FUNCS` is
 * not in `SEQUENCED_VERBS` either. The host appends one entry per
 * `funcs <name> [signature]` reply line to `link.session.functions`
 * (see `wsMessages.ts`'s `RobotFunction`); this button only fires the
 * request. Rendering the resulting list is `FunctionsPanel`'s job, not
 * this component's -- consistent with this component never rendering a
 * reply area of its own.
 */
import { useMemo, useState } from "react";
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { useLinkLog, useSendable, useWsActions } from "../ws/WsProvider";
import { isLinkUsable } from "../deviceDisplay";
import "./CommandStrip.css";

/** Matches a `get <name> ...` reply line and captures `<name>`.
 * Mirrors `DeviceConsole.classifyLine`'s loose prefix-match discipline
 * (`/^(err|nack)\b/i`) rather than parsing to a fixed reply grammar --
 * protocol.md promises only "one `get <name> <value>` line per known
 * field", nothing stricter. */
const GET_REPLY_PATTERN = /^get\s+(\S+)/i;

export interface CommandStripProps {
  link: SnapshotLink;
}

export function CommandStrip({ link }: CommandStripProps) {
  const linkId = link.id;
  const sendable = useSendable();
  const linkOpen = isLinkUsable(link) && sendable;
  const { sendCommand } = useWsActions();
  const log = useLinkLog(linkId);

  const [nameDraft, setNameDraft] = useState("");
  const [valueDraft, setValueDraft] = useState("");

  // Discovered field names, derived from the link's log rather than
  // held as separately-mutated state -- recomputing from `log` on every
  // change keeps this in sync with `DeviceConsole`'s clear-log action
  // too (a cleared log naturally clears discovery, since there is
  // nothing left to derive names from) instead of needing its own reset
  // path. No on-mount/on-reopen probe fires this any more -- see this
  // module's doc comment ("Sprint 015 ticket 009").
  const discoveredNames = useMemo(() => {
    const names = new Set<string>();
    for (const entry of log) {
      if (entry.direction !== "rx" || entry.origin === "host") {
        continue;
      }
      const match = GET_REPLY_PATTERN.exec(entry.line.trimStart());
      const name = match?.[1];
      if (name !== undefined) {
        names.add(name);
      }
    }
    return Array.from(names).sort();
  }, [log]);

  const nameListId = `command-strip-name-options-${linkId}`;

  function handleGet(): void {
    if (!linkOpen) {
      return;
    }
    const name = nameDraft.trim();
    if (name.length > 0) {
      sendCommand(linkId, "GET", [name]);
    } else {
      sendCommand(linkId, "GET");
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
    sendCommand(linkId, "SET", [name, value]);
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
          onClick={() => sendCommand(linkId, "HELLO")}
        >
          HELLO
        </button>
        <button
          type="button"
          className="command-strip-button"
          data-testid="command-strip-id"
          disabled={!linkOpen}
          onClick={() => sendCommand(linkId, "ID")}
        >
          ID
        </button>
        <button
          type="button"
          className="command-strip-button"
          data-testid="command-strip-ver"
          disabled={!linkOpen}
          onClick={() => sendCommand(linkId, "VER")}
        >
          VER
        </button>
        <button
          type="button"
          className="command-strip-button"
          data-testid="command-strip-status"
          disabled={!linkOpen}
          onClick={() => sendCommand(linkId, "STATUS")}
        >
          STATUS
        </button>
        <button
          type="button"
          className="command-strip-button"
          data-testid="command-strip-funcs"
          disabled={!linkOpen}
          onClick={() => sendCommand(linkId, "FUNCS")}
        >
          FUNCS
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
            list={nameListId}
            data-testid="command-strip-name"
            value={nameDraft}
            onChange={(event) => setNameDraft(event.target.value)}
            placeholder="(empty = every field)"
            disabled={!linkOpen}
          />
          {/* Editable combo box, never a closed <select> -- a name the
              device didn't report (or hasn't reported yet) is still
              typeable and sendable; see the doc comment above. */}
          <datalist id={nameListId} data-testid="command-strip-name-options">
            {discoveredNames.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
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
