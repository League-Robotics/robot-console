/**
 * One-time importer: `known-robots.json` (the file
 * `../knownRobots.ts`'s `KnownRobotsStore` reads/writes) → `devices`
 * rows with `owned = 1`, `kind = 'robot'` — SUC-005 ("previously-owned
 * robots appear from the one-time import").
 *
 * ## The id problem
 *
 * `known-robots.json` never recorded the true 32-bit `FICR.DEVICEID[1]`
 * — only the derived five-letter `name` and, as a non-authoritative
 * display hint, the *USB interface chip's* serial (`lastUsbSerial`,
 * unrelated hardware — see `knownRobots.ts`'s own doc comment). There is
 * therefore no way to recover the original chip id from this file
 * alone; names collide with ~79% probability over a 100-robot fleet
 * (architecture.md §4), so this is a real, not theoretical, gap.
 *
 * This importer uses `nameToValue(name)` — the unique value in
 * `[0, 3124]` whose `deviceIdToName` is exactly `name` — as a synthetic
 * placeholder `devices.id`. This is safe for `Store.upsertDevice`'s own
 * `deviceIdToName(id) === name` assertion (`nameToValue`/`deviceIdToName`
 * are exact inverses over that range — see `packages/protocol/src/naming.ts`),
 * and it is enough to give every previously-known robot a row before
 * any watcher has run. If the real device is later plugged in over USB,
 * `upsertDevice` writes its true observed id there, which may differ
 * from this placeholder if `name`'s collision was ever realized on this
 * host — an accepted limitation carried over from a legacy file that
 * never stored the true id, not something this importer can fix.
 *
 * ## One-time, not idempotent-by-accident
 *
 * A `settings` row (`IMPORT_GUARD_KEY`) records that this import has
 * run; a second call is a no-op even if the file has changed since —
 * "one-time" is enforced explicitly, not merely an accidental property
 * of upserting. The source file itself is never modified or deleted.
 */
import { existsSync, readFileSync } from "node:fs";
import { nameToValue } from "@robot-console/protocol";
import type { Store } from "../index.js";

const IMPORT_GUARD_KEY = "import:known-robots";

/**
 * The on-disk `known-robots.json` record/file shape this importer reads.
 * Sprint 015 ticket 003 inlines these here (previously imported from
 * `store/knownRobots.ts`, the old in-memory `KnownRobotsStore` module
 * that ticket retires along with `deviceRegistry.ts`) — this importer is
 * the shape's one remaining reader, so a shared module is no longer
 * warranted. Field-for-field identical to the retired module's own
 * types; see this file's own module doc comment for what each field
 * means.
 */
export interface KnownRobotRecord {
  name: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastSeenVia: "usb";
  lastUsbSerial: string;
  lastRole: string | null;
  lastType: "robot";
}

export interface KnownRobotsFile {
  version: number;
  robots: KnownRobotRecord[];
}

export interface ImportKnownRobotsResult {
  /** Number of records upserted this call — always `0` once the guard
   * has been set by an earlier call. */
  imported: number;
}

/** Injectable filesystem seam, mirroring `knownRobots.ts`'s own
 * pattern — defaults to real `node:fs`. */
export interface ImportKnownRobotsDeps {
  existsSync?: (filePath: string) => boolean;
  readFileSync?: (filePath: string) => string;
}

function isKnownRobotRecord(value: unknown): value is KnownRobotRecord {
  return typeof value === "object" && value !== null && typeof (value as { name?: unknown }).name === "string";
}

/**
 * Imports `filePath` (a `known-robots.json`-shaped file) into `store`
 * once. Returns `{ imported: 0 }` without touching the store on every
 * call after the first — including when the file is missing (nothing
 * to import; the guard is only set once a real import has happened, so
 * a file that appears later is still picked up) or unparseable (treated
 * the same "never fatal" way `KnownRobotsStore` itself treats corrupt
 * JSON).
 */
export function importKnownRobots(
  store: Store,
  filePath: string,
  deps: ImportKnownRobotsDeps = {},
): ImportKnownRobotsResult {
  const existsFn = deps.existsSync ?? existsSync;
  const readFn = deps.readFileSync ?? ((path: string) => readFileSync(path, "utf8"));

  if (store.getSetting(IMPORT_GUARD_KEY) === "done") {
    return { imported: 0 };
  }
  if (!existsFn(filePath)) {
    return { imported: 0 };
  }

  let parsed: Partial<KnownRobotsFile>;
  try {
    parsed = JSON.parse(readFn(filePath)) as Partial<KnownRobotsFile>;
  } catch {
    return { imported: 0 };
  }

  const robots = Array.isArray(parsed.robots) ? parsed.robots.filter(isKnownRobotRecord) : [];
  const now = Date.now();
  let imported = 0;
  for (const robot of robots) {
    const id = nameToValue(robot.name);
    const firstSeenMs = Date.parse(robot.firstSeenAt);
    const lastSeenMs = Date.parse(robot.lastSeenAt);

    // upsertDevice's single `at` seeds first_seen == last_seen on
    // insert; setOwned below corrects last_seen to the file's own
    // lastSeenAt (usually later) and marks the row owned, satisfying
    // SUC-005's `owned = 1` postcondition.
    store.upsertDevice({
      id,
      name: robot.name,
      kind: "robot",
      role: robot.lastRole ?? null,
      usbSerial: robot.lastUsbSerial ?? null,
      at: Number.isFinite(firstSeenMs) ? firstSeenMs : now,
    });
    store.setOwned(id, true, Number.isFinite(lastSeenMs) ? lastSeenMs : now);
    imported++;
  }

  store.setSetting(IMPORT_GUARD_KEY, "done");
  return { imported };
}
