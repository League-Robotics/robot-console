/**
 * dumpStore.ts — SUC-006's read-only store inspector (ticket 014-009):
 * open a short-lived, read-only connection to `console.sqlite` and
 * return `devices`/`links`/`services`/`sessions`/`tasks` as plain JSON
 * rows, so an engineer can check watcher output without the UI or a
 * running reconciler (`sprint.md`'s Step 6 Design Rationale).
 *
 * Deliberately thin: all connection-opening lives in
 * {@link openReadOnlyStoreDb} (`store/db.ts`), and all row-reading lives
 * in {@link Store.snapshotRows} (`store/index.ts`) — this module reuses
 * both rather than duplicating either, and never issues raw SQL of its
 * own (`store/README.md`'s "no SQL outside store/" rule).
 *
 * TODO(rearch-06): this is an explicitly throwaway sprint-014 debugging
 * affordance. Sprint 015 replaces it with the real `snapshot` projection
 * and a server endpoint (`sprint.md`'s Design Rationale) — this module
 * is not meant to survive past that sprint.
 */
import { openReadOnlyStoreDb, type StoreDbOptions } from "../store/db.js";
import { Store, type StoreSnapshot } from "../store/index.js";

/** What {@link dumpStore} returns when `console.sqlite` does not exist
 * yet — every table empty, rather than an error. A read-only connection
 * must never create the file (that would defeat "read-only"), and a
 * host that has never run yet (or a fresh `ROBOT_CONSOLE_STATE_DIR`) is
 * a normal, expected state for this tool to be pointed at. */
const EMPTY_SNAPSHOT: StoreSnapshot = {
  devices: [],
  links: [],
  services: [],
  sessions: [],
  tasks: [],
};

/**
 * Open a short-lived read-only connection (via {@link openReadOnlyStoreDb})
 * and return every table {@link StoreSnapshot} covers. Always closes the
 * connection before returning, whether or not reading it throws.
 * Returns {@link EMPTY_SNAPSHOT} untouched if `console.sqlite` does not
 * exist yet.
 */
export function dumpStore(options: StoreDbOptions = {}): StoreSnapshot {
  const db = openReadOnlyStoreDb(options);
  if (db === undefined) {
    return EMPTY_SNAPSHOT;
  }

  const store = new Store(db);
  try {
    return store.snapshotRows();
  } finally {
    store.close();
  }
}

/** Formats a {@link StoreSnapshot} as the dump CLI's stdout output —
 * pretty-printed JSON, one object keyed by table name. */
export function formatStoreDump(snapshot: StoreSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}
