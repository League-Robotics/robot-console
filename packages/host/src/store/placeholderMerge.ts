/**
 * placeholderMerge.ts — `mergeNamePlaceholderIfAny`, shared between
 * `connect/connector.ts` (a successful banner identify) and
 * `watchers/usbWatcher.ts` (a successful SWD name read) — sprint 017
 * ticket 010, bench defect "the same robot appears twice"
 * (2026-09-13). Lives under `store/` (not `connect/`) so both callers
 * can import it without a cycle, and so it can honestly claim "only
 * typed `Store` ops, no SQL outside `store/`" (`store/README.md`'s own
 * rule) from a location that rule already governs.
 *
 * ## Why usbWatcher needs its own call to this, not just connector.ts's
 *
 * `connect/connector.ts`'s `attempt()` already called this exact merge
 * (moved here verbatim, no behavior change) — but only after a full
 * connect *and* a successful banner identify. SWD naming
 * (`usbWatcher.ts`'s `attach()`) is a *separate*, earlier identification
 * step over the debug interface (chip id read directly, no serial
 * handshake at all) that a bad USB cable cannot corrupt the same way a
 * banner read can — bench evidence (2026-09-13): `tovez`'s known-robots
 * placeholder (id 2665, `owned: 1`) never merged with its real,
 * SWD-named row (id 2314287040) because the board's flaky cable meant
 * `connectAndIdentify` never once completed a successful banner identify
 * for it, so `connector.ts`'s own merge call never ran, even though the
 * *name* was known and correct from the moment SWD naming succeeded.
 * Calling this same merge right after a successful SWD name read closes
 * that gap: identity is trustworthy the instant SWD naming succeeds,
 * independent of whether the serial link ever becomes readable.
 */
import { nameToValue } from "@robot-console/protocol";
import { Store } from "./index.js";

/**
 * Generalizes the merge to any transport's first identification (sprint
 * 017 ticket 006; SUC-006) or, as of this ticket, any *identification
 * method's* first success — a robot first identified over
 * `mbserial`/`wifi`/a banner, or (this ticket) via a successful SWD name
 * read alone, has no USB serial to correlate against
 * `mergeUsbPlaceholderIfAny`'s own join key, so a `known-robots.json`
 * -seeded placeholder for that robot (synthetic id, no true chip id) and
 * its real row never collapse without this.
 *
 * A placeholder is defined by how it was constructed:
 * `store/importers/knownRobots.ts` always seeds a robot placeholder's id
 * as exactly `nameToValue(name)` — the same convention
 * `watchers/mdnsWatcher.ts`'s `createRelayDeviceIfAbsent` uses for a
 * relay pool row. A row's `usb_serial` plays no part in this decision
 * either way (it is "last seen via USB" telemetry, not an identity
 * claim). Since `nameToValue` is a pure function of `name` with exactly
 * one output, and `devices.id` is the table's own primary key, at most
 * one row can ever have `id === nameToValue(name)` — a plain `find`
 * suffices, no `candidates.length` ambiguity check needed. The real
 * ambiguous case this function still declines to guess at — two
 * `kind='robot'` rows sharing `name` where *neither* has `id ===
 * nameToValue(name)` — is left untouched, same "leave it alone,
 * `forget-device` is the manual escape hatch" outcome as before.
 *
 * A no-op when nothing matches (nothing to merge, nothing imported from
 * `known-robots.json` for this name, or the placeholder already merged).
 */
export function mergeNamePlaceholderIfAny(store: Store, name: string, deviceId: number, at: number): void {
  const placeholderId = nameToValue(name);
  const placeholder = store
    .snapshotRows()
    .devices.find((row) => row.kind === "robot" && Number(row.id) === placeholderId && Number(row.id) !== deviceId);
  if (placeholder) {
    store.mergeDevice(Number(placeholder.id), deviceId, at);
  }
}
