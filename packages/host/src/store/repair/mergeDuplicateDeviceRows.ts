/**
 * mergeDuplicateDeviceRows.ts — the one-time, idempotent repair that
 * completes SUC-003's radio-hygiene fix (ticket 018-006, issue
 * `bench-stale-radio-links-and-duplicate-rows-persist.md`).
 *
 * ## Why this exists alongside `placeholderMerge.ts`
 *
 * `store/placeholderMerge.ts`'s `mergeNamePlaceholderIfAny` (sprint 017
 * ticket 006/010) already merges a `known-robots.json` placeholder
 * device row into its real, same-name counterpart -- but only at the
 * moment a *new* identification happens (a banner reply over
 * `connect/connector.ts`, or a fresh SWD name read over
 * `watchers/usbWatcher.ts`). Both callers require a live event to fire
 * the merge; a database that already carries a placeholder *and* its
 * real row from before those fixes landed -- exactly the stakeholder's
 * live `console.sqlite`, evidenced 2026-09-13 as `gopiv` `1461`
 * (placeholder, `owned 1`, with the mbserial/radio links hanging off
 * it) alongside `gopiv 2175407711` (real, `owned 0`) -- is never
 * repaired by either call site: nothing forces a fresh identify to
 * happen just to fix old data.
 *
 * This module is the one-time backfill for exactly that case: run once
 * on every store open (after migrations, before any watcher starts),
 * find every remaining placeholder/real pair, and merge them the same
 * way `mergeNamePlaceholderIfAny` would have, had it run at the right
 * moment. It reuses {@link Store.mergeDevice} directly -- the same
 * primitive `placeholderMerge.ts` calls -- so there is exactly one
 * place that knows how to fold two device rows (and their `links`/
 * `sightings`) into one; this module's own job is only to *find* the
 * pairs `mergeNamePlaceholderIfAny` never got a chance to see.
 *
 * ## What counts as a placeholder
 *
 * Identical convention to `placeholderMerge.ts`: a `kind: "robot"` row
 * whose `id` equals `nameToValue(name)` -- the synthetic id
 * `store/importers/knownRobots.ts` mints for a robot it has never
 * chip-id-identified. A `kind: "relay"` row is never treated as a
 * placeholder here (relay rows use their own synthetic-id convention,
 * `mdnsWatcher.ts`'s `createRelayDeviceIfAbsent`, and are out of this
 * ticket's scope entirely -- "never merge relay rows").
 *
 * ## Ambiguity is left alone, not guessed at
 *
 * A placeholder merges only when **exactly one** other `kind: "robot"`
 * row shares its `name` (and is not itself a placeholder-shaped row for
 * a *different* id -- impossible in practice since `devices.id` is the
 * primary key, but guarded here for clarity). Zero matches means the
 * robot has never been re-identified since import -- left alone, per
 * the issue's own scope ("this ticket only merges when both rows
 * exist"). More than one match is the same irreducible ambiguity
 * `placeholderMerge.ts`'s own doc comment already declines to guess at
 * ("two `kind='robot'` rows sharing `name` where neither has
 * `id === nameToValue(name)`") -- `forget-device` remains the manual
 * escape hatch for that case, never this automatic repair.
 */
import { nameToValue } from "@robot-console/protocol";
import type { Store } from "../index.js";

/** One `devices` row shape, as read off {@link Store.snapshotRows}'s
 * untyped passthrough -- just enough to classify placeholder vs. real. */
interface DeviceRowForRepair {
  id: number;
  name: string;
  kind: string;
}

function toDeviceRowForRepair(row: Record<string, unknown>): DeviceRowForRepair {
  return { id: Number(row.id), name: String(row.name), kind: String(row.kind) };
}

/**
 * Runs the one-time duplicate-device-row repair against `store`: every
 * remaining `kind: "robot"` placeholder row (`id === nameToValue(name)`)
 * with exactly one same-name, non-placeholder `kind: "robot"` row is
 * merged into that real row via {@link Store.mergeDevice} (`owned`
 * OR'd, `usb_serial`/radio fields preferred from the real row's own
 * non-null values, every `links`/`sightings` row re-pointed, the
 * placeholder deleted).
 *
 * Idempotent: once every placeholder has merged (or been left alone for
 * having no match), a store with no placeholder rows left does nothing
 * on a later call -- the `find`/group pass below simply finds no
 * `id === nameToValue(name)` row to act on.
 */
export function mergeDuplicateDeviceRows(store: Store, at: number): void {
  const devices = store.snapshotRows().devices.map(toDeviceRowForRepair);

  const isPlaceholder = (row: DeviceRowForRepair): boolean => row.kind === "robot" && row.id === nameToValue(row.name);

  const realRobotIdsByName = new Map<string, number[]>();
  for (const row of devices) {
    if (row.kind !== "robot" || isPlaceholder(row)) {
      continue;
    }
    const ids = realRobotIdsByName.get(row.name) ?? [];
    ids.push(row.id);
    realRobotIdsByName.set(row.name, ids);
  }

  for (const row of devices) {
    if (!isPlaceholder(row)) {
      continue;
    }
    const realIds = realRobotIdsByName.get(row.name) ?? [];
    if (realIds.length !== 1) {
      // No real row yet, or more than one -- leave alone either way
      // (see this module's own doc comment, "Ambiguity is left alone").
      continue;
    }
    const [realId] = realIds;
    store.mergeDevice(row.id, realId!, at);
  }
}
