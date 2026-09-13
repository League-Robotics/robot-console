/**
 * repairRadioLinkDeviceAssociation.ts — the one-time, idempotent repair
 * for ticket 018-010's own bench-evidenced data defect: a `radio`/
 * `mbrelay` "child" link whose own id names one robot (the
 * `connect/relayBridger.ts`/`watchers/relaySweeper.ts` shared convention,
 * `<transport>-<name>-via-<relayLinkId>`) but whose `device_id` column
 * pointed at a *different* device row entirely.
 *
 * ## Bench evidence
 *
 * The stakeholder's real `console.sqlite` carried
 * `radio-tigez-via-mbrelay-torture` — a link id that names `tigez` — with
 * `device_id` set to `gopiv`'s own numeric id. `gopiv`'s front-page card
 * then showed `Radio · ch55/grp114 (via relay torture)`, ch55/grp114
 * being `tigez`'s own radio address, not `gopiv`'s: a card describing a
 * different robot's connection entirely. `Store.upsertLink`'s own
 * write-time guard (this ticket's other half — see that method's doc
 * comment) stops any *new* write from reintroducing this, but it does
 * nothing for a row already sitting wrong in an existing database; this
 * module is the one-time backfill for exactly that, mirroring
 * `mergeDuplicateDeviceRows.ts`'s own shape (018-006) — run once, at
 * `openStore`, before any watcher/reconciler starts.
 *
 * ## The rule
 *
 * For every `links` row whose `id` parses as `<radio|mbrelay>-<name>-
 * via-<relayLinkId>` (a well-formed five-letter robot name — see
 * {@link radioChildLinkName}'s own doc comment): if a `kind = 'robot'`
 * device named `<name>` exists, that device's id is what the row's
 * `device_id` must be — re-pointed if it currently names anything else,
 * including a `NULL` (never associated in the first place, e.g. an
 * address-only row `server.ts`'s `session-open` handler wrote before any
 * device row was known to exist). If no such device exists at all yet,
 * `device_id` is cleared to `NULL` — a link can never be attributed to a
 * device that doesn't exist, and this is the only sound alternative
 * to "attributed to whatever device happened to be there before" once a
 * mismatch is found. Idempotent: once every such row's `device_id`
 * already matches its own id-named device (the overwhelmingly common
 * case — this mismatch is a data anomaly, not the norm), a later call
 * finds nothing left to change.
 *
 * ## Never a relay row
 *
 * A relay's own connectivity link (`usb-<serial>`, or its own `mbrelay-
 * <name>` id from `watchers/mdnsWatcher.ts`) never matches the
 * `<transport>-<name>-via-<relayLinkId>` shape (no `-via-` segment at
 * all), so this repair never touches it — out of scope by construction,
 * not by an extra guard.
 */
import type { Store } from "../index.js";

/**
 * Parses the robot name a `radio`/`mbrelay` child link's own id encodes —
 * the identical rule `store/index.ts`'s own `radioChildLinkName` applies
 * for {@link Store.upsertLink}'s write-time guard. Duplicated here
 * (rather than imported) solely to avoid a runtime import cycle between
 * this file and `store/index.ts` (this module already imports `Store`'s
 * *type* from there; `store/index.ts` imports this module's own {@link
 * repairRadioLinkDeviceAssociation} function to call from `openStore` —
 * a genuine two-way runtime dependency a shared-helper import would
 * create). Kept in sync by name with that module's own copy; both apply
 * the exact same regex and five-letter well-formedness check (this
 * copy via the plain {@link NAME_PATTERN} regex below; `store/index.ts`'s
 * own copy via `@robot-console/protocol`'s `nameToValue`, already
 * imported there for other checks) — either one accepts exactly the same
 * set of names.
 */
function radioChildLinkName(linkId: string): string | undefined {
  const match = /^(?:radio|mbrelay)-([a-z]+?)-via-.+$/.exec(linkId);
  if (!match) {
    return undefined;
  }
  const candidate = match[1] as string;
  return NAME_PATTERN.test(candidate) ? candidate : undefined;
}

/** `^[zvgpt][uoiea][zvgpt][uoiea][zvgpt]$` — a well-formed five-letter
 * friendly name (`@robot-console/protocol`'s own `naming.ts`, not
 * exported from that package — reproduced here rather than round-tripped
 * through `nameToValue`'s throw/catch, since this module runs once over
 * every link row at store open and a plain regex test is simpler than a
 * try/catch per row for the same yes/no answer). */
const NAME_PATTERN = /^[zvgpt][uoiea][zvgpt][uoiea][zvgpt]$/;

interface LinkRowForRepair {
  id: string;
  deviceId: number | null;
}

interface DeviceRowForRepair {
  id: number;
  name: string;
  kind: string;
}

function toLinkRowForRepair(row: Record<string, unknown>): LinkRowForRepair {
  const deviceId = row.device_id;
  return { id: String(row.id), deviceId: deviceId === null || deviceId === undefined ? null : Number(deviceId) };
}

function toDeviceRowForRepair(row: Record<string, unknown>): DeviceRowForRepair {
  return { id: Number(row.id), name: String(row.name), kind: String(row.kind) };
}

/**
 * Runs the one-time radio/mbrelay link device-association repair against
 * `store` — see this module's own doc comment for the exact rule.
 */
export function repairRadioLinkDeviceAssociation(store: Store): void {
  const rows = store.snapshotRows();
  const devices = rows.devices.map(toDeviceRowForRepair);
  const links = rows.links.map(toLinkRowForRepair);

  const robotIdByName = new Map<string, number>();
  for (const device of devices) {
    if (device.kind === "robot") {
      robotIdByName.set(device.name, device.id);
    }
  }

  for (const link of links) {
    const name = radioChildLinkName(link.id);
    if (name === undefined) {
      continue;
    }
    const correctDeviceId = robotIdByName.get(name) ?? null;
    if (link.deviceId !== correctDeviceId) {
      store.setLinkDeviceId(link.id, correctDeviceId);
    }
  }
}
