/**
 * removeLocalHostDeviceRows.ts — the one-time, idempotent repair for
 * ticket 018-010's other bench-evidenced defect: the stakeholder's own
 * front page showed a card named `gala` (his Mac's own hostname) with
 * "No role announced" — this very machine, at some point before
 * `watchers/mdnsWatcher.ts`'s own new `isLocalMdnsService` guard
 * existed, minted itself a `kind='relay'` device row via the ordinary
 * `_mbrelay._tcp`/`_mbserial._tcp` minting path (`handleMbrelay`'s
 * `createRelayDeviceIfAbsent`, ticket 016-005). That guard stops any
 * *new* self-mint, but does nothing for a row an unfiltered run already
 * wrote — this repair is the one-time backfill for exactly that,
 * mirroring this same ticket's own sibling repairs
 * (`repairDeviceKindFromRole.ts`, `repairRadioLinkDeviceAssociation.ts`):
 * run once, at `openStore`, before any watcher/reconciler starts.
 *
 * ## The rule
 *
 * A `kind='relay'` device row whose `name` normalizes ({@link
 * normalizeHostCandidate}) to this machine's own hostname ({@link
 * localHostname}) is not a relay at all — it is this host's own
 * mDNS footprint. Every `links` row still pointing at it is deleted
 * outright ({@link Store.deleteLink} — a link that should never have
 * existed, not a device being forgotten while its link rows survive as
 * still-observable endpoints), then the device row itself. Idempotent:
 * once no `kind='relay'` row's name matches this machine's own
 * hostname (the overwhelmingly common case — this defect requires a
 * relay/bridge process to have run, at some point, on the very same
 * machine this console itself now runs on), a later call finds nothing
 * left to remove.
 *
 * ## Only `kind='relay'`, never `kind='robot'`
 *
 * A `kind='robot'` device's own `name` is always a well-formed
 * five-letter micro:bit name (`store/index.ts`'s own consistency
 * check: `deviceIdToName(id) === name`) — a real machine hostname
 * (`gala`, four letters; a typical `Some-Mac.local`, longer and mixed
 * case) can never collide with that shape, so restricting this rule to
 * `kind='relay'` costs nothing and avoids ever touching a device this
 * repair has no business reasoning about.
 */
import { localHostname, normalizeHostCandidate } from "../../localHost.js";
import type { Store } from "../index.js";

interface DeviceRowForRepair {
  id: number;
  name: string;
  kind: string;
}

interface LinkRowForRepair {
  id: string;
  deviceId: number | null;
}

function toDeviceRowForRepair(row: Record<string, unknown>): DeviceRowForRepair {
  return { id: Number(row.id), name: String(row.name), kind: String(row.kind) };
}

function toLinkRowForRepair(row: Record<string, unknown>): LinkRowForRepair {
  const deviceId = row.device_id;
  return { id: String(row.id), deviceId: deviceId === null || deviceId === undefined ? null : Number(deviceId) };
}

/**
 * Runs the local-host device-row repair against `store` — see this
 * module's own doc comment for the exact rule.
 */
export function removeLocalHostDeviceRows(store: Store): void {
  const hostname = localHostname();
  const rows = store.snapshotRows();
  const devices = rows.devices.map(toDeviceRowForRepair);
  const links = rows.links.map(toLinkRowForRepair);

  for (const device of devices) {
    if (device.kind !== "relay" || normalizeHostCandidate(device.name) !== hostname) {
      continue;
    }
    for (const link of links) {
      if (link.deviceId === device.id) {
        store.deleteLink(link.id);
      }
    }
    store.deleteDevice(device.id);
  }
}
