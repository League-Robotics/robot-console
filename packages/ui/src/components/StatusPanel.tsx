/**
 * StatusPanel.tsx — the robot's parsed `status` reply, rendered
 * read-mostly on `RobotPage` (added out-of-process, 2026-09-09).
 *
 * Reads `link.session?.robotStatus` only (`wsMessages.ts`'s
 * `RobotStatus`), populated host-side from the most recent `status`/bare
 * `estop` reply on the link's open session. The harvester (ticket 003)
 * polls `STATUS` on its own every few seconds while a session is open,
 * so this panel refreshes itself passively, with no probe or timer of
 * its own.
 *
 * ## Sprint 015 ticket 009: reads from the snapshot, no on-open probe
 *
 * Before this ticket, this panel sent its own one-shot `STATUS` on mount
 * (if the link was already open) and again on every closed->open
 * transition, mirroring `CommandStrip`'s discovery `GET` -- duplicating
 * the harvester's own poll, which now starts as soon as a session opens
 * (well before this component could ever mount to fire its own request).
 * That effect is deleted outright, not adapted: `link.session.robotStatus`
 * already reflects the harvester's own poll cadence, so there is nothing
 * left for a component-local probe to add.
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
 */
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { useSendable, useWsActions } from "../ws/WsProvider";
import "./StatusPanel.css";

/** OOP 2026-09-10: the firmware's `status k=v` keys, given real names
 * and decoded values (stakeholder: "make that a real little table with
 * actual names for things"). The key set comes from
 * `wire_handler.cpp`'s STATUS format string; an unlisted key falls
 * through with its raw key and value so a newer firmware never hides a
 * field. Order here is display order. */
const STATUS_FIELDS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "ready", label: "Ready" },
  { key: "active", label: "Moving" },
  { key: "connL", label: "Left motor" },
  { key: "connR", label: "Right motor" },
  { key: "otos", label: "Odometry sensor" },
  { key: "wedge", label: "Bus wedged" },
  { key: "flags", label: "Flags" },
  { key: "i2cf", label: "I2C faults" },
  { key: "cyc", label: "Control cycles" },
  { key: "tlm", label: "Telemetry" },
  { key: "next", label: "Next command id" },
  { key: "done", label: "Last completed id" },
  { key: "reason", label: "Last completion" },
];

/** Bit names from `wire_adapter.cpp`'s `kFlag*` constants. */
const FLAG_NAMES = [
  "Ready",
  "E-stop",
  "Stall halted",
  "Lease expired",
  "Left motor connected",
  "Right motor connected",
  "Left wedge",
  "Right wedge",
];

function describeFlags(raw: string): string {
  const value = Number.parseInt(raw, 16);
  if (!Number.isFinite(value)) {
    return raw;
  }
  const names: string[] = [];
  for (let bit = 0; bit < 32; bit += 1) {
    if (value & (1 << bit)) {
      names.push(FLAG_NAMES[bit] ?? `bit ${bit}`);
    }
  }
  return `${names.length === 0 ? "none" : names.join(", ")} (0x${raw})`;
}

function yesNo(raw: string): string {
  return raw === "1" ? "Yes" : raw === "0" ? "No" : raw;
}

/** Exported for `StatusPanel.test.tsx`. */
export function describeStatusValue(key: string, raw: string): string {
  switch (key) {
    case "ready":
    case "active":
    case "wedge":
      return yesNo(raw);
    case "connL":
    case "connR":
      // OOP 2026-09-10 (stakeholder): a 0 here only means the motor has
      // not been seen moving -- nothing has been commanded yet -- not
      // that it is disconnected.
      return raw === "1" ? "Connected" : raw === "0" ? "Not seen moving yet" : raw;
    case "otos":
      return raw === "1" ? "Detected" : raw === "0" ? "Not detected" : raw;
    case "flags":
      return describeFlags(raw);
    case "tlm":
      return raw.toUpperCase();
    default:
      return raw;
  }
}

/** Exported for `StatusPanel.test.tsx`: the table rows in display
 * order -- known keys first with their labels, then anything else the
 * firmware sent, raw. */
export function statusRows(fields: Record<string, string>): Array<{ key: string; label: string; value: string }> {
  const rows: Array<{ key: string; label: string; value: string }> = [];
  const seen = new Set<string>();
  for (const { key, label } of STATUS_FIELDS) {
    if (key in fields) {
      rows.push({ key, label, value: describeStatusValue(key, fields[key]!) });
      seen.add(key);
    }
  }
  for (const [key, value] of Object.entries(fields)) {
    if (!seen.has(key)) {
      rows.push({ key, label: key, value });
    }
  }
  return rows;
}

export interface StatusPanelProps {
  link: SnapshotLink;
}

export function StatusPanel({ link }: StatusPanelProps) {
  const linkId = link.id;
  const sendable = useSendable();
  const linkOpen = link.session !== undefined && sendable;
  const { sendCommand } = useWsActions();
  const status = link.session?.robotStatus ?? undefined;

  const isEstopped = status?.estopped === true;

  function handleClearEstop(): void {
    sendCommand(linkId, "SET", ["estop_clear", "1"]);
    sendCommand(linkId, "STATUS");
  }

  return (
    // Deliberately not classed "status-panel" -- that class name belongs
    // to sprint 006's retired status-request panel, and
    // `RobotPage.test.tsx` guards against its reappearance.
    <section className="robot-status-panel" aria-label="Robot status">
      <div className="status-panel-heading">
        <h3>Status</h3>
        {/* OOP 2026-09-10 (stakeholder): no Ready/Moving word up here --
            the table already says both. Only two things are worth a
            word on this line: an e-stop, and "no status yet". */}
        {isEstopped && (
          <span className="status-panel-state status-panel-state-danger" data-testid="status-panel-state">
            E-STOPPED
          </span>
        )}
        {!status && (
          <span className="status-panel-note" data-testid="status-panel-state">
            {linkOpen ? "Waiting for the robot's status…" : "No link open"}
          </span>
        )}
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

      {status && (
        <table className="status-panel-table" data-testid="status-panel-fields">
          <tbody>
            {statusRows(status.fields).map((row) => (
              <tr key={row.key}>
                <th scope="row">{row.label}</th>
                <td>{row.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
