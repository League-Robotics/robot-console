/**
 * db.ts — opens (creating if needed) `console.sqlite`, the one
 * `node:sqlite` connection every other store module and watcher shares
 * (architecture.md §3, "store"). This ticket is schema/migrations
 * only: typed operations, the change feed, and the `known-robots.json`/
 * `wifi-credentials.json` importers are ticket 003.
 *
 * ## Location
 *
 * The database lives beside `known-robots.json`, in the same state
 * directory {@link resolveStateDir} resolves — one file,
 * `console.sqlite`, per architecture.md §4's closing note.
 *
 * ## Mode
 *
 * WAL journal mode and a `busy_timeout` are set via `PRAGMA` on every
 * open (idempotent — re-asserting an already-set pragma is a no-op),
 * rather than the `DatabaseSyncOptions.timeout` constructor option,
 * since that option requires a newer `node:sqlite` than this project's
 * `engines.node` floor (ticket 001's `>=22.13`) guarantees.
 *
 * ## Migrations
 *
 * Schema changes are ordered SQL migrations in `./migrations/`, applied
 * by array index against `PRAGMA user_version`: a fresh database opens
 * at `user_version 0` and every migration from index 0 up to the array
 * length runs once, in order, each inside its own transaction that bumps
 * `user_version` to `index + 1` on success. Re-opening an
 * already-migrated file is a no-op — `user_version` already equals
 * `MIGRATIONS.length`, so the loop's range is empty.
 */
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { resolveStateDir, type StateDirOptions } from "./stateDir.js";
import { MIGRATION_0001_INITIAL } from "./migrations/0001-initial.js";

const DB_FILENAME = "console.sqlite";

/** Default SQLite `busy_timeout`, in milliseconds: how long a writer
 * waits for a lock held by another connection (or, on WAL, a reader
 * mid-checkpoint) before giving up. Long-lived tasks retry on their own
 * schedule, so this only needs to smooth over brief contention, not
 * every possible stall. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/** Ordered schema migrations. Array index `n` is applied to move the
 * database from `user_version n` to `user_version n + 1`. Append here,
 * never edit an already-shipped entry — the same discipline as any other
 * migration list. */
const MIGRATIONS: readonly string[] = [MIGRATION_0001_INITIAL];

export interface StoreDbOptions extends StateDirOptions {
  /** Exact file path to use, overriding directory resolution entirely.
   * Tests point this at a file inside their own temp directory. */
  filePath?: string;
  /** Environment to resolve {@link resolveStateDir}'s
   * `ROBOT_CONSOLE_STATE_DIR`/`XDG_STATE_HOME` from when neither
   * `filePath` nor `stateDir` is given. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** `PRAGMA busy_timeout` value, in milliseconds. Defaults to
   * {@link DEFAULT_BUSY_TIMEOUT_MS}. */
  busyTimeoutMs?: number;
}

/**
 * Resolve the on-disk path for `console.sqlite`: an explicit `filePath`
 * if given, else {@link resolveStateDir}'s directory joined with this
 * file's name — the same directory `known-robots.json` and
 * `wifi-credentials.json` already live in.
 */
export function resolveDbFilePath(
  options: { filePath?: string; stateDir?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (options.filePath !== undefined) {
    return options.filePath;
  }
  return path.join(resolveStateDir(options, env), DB_FILENAME);
}

/**
 * Open (creating the file and its parent directory if needed) the
 * console's SQLite store: WAL journal mode, a `busy_timeout`, and every
 * migration up to the latest applied via `PRAGMA user_version`.
 *
 * Returns the one live `DatabaseSync` connection. Callers own its
 * lifetime and must `close()` it when done (tests always do, so a run
 * never leaves a WAL/SHM file locked for the next one).
 */
export function openStoreDb(options: StoreDbOptions = {}): DatabaseSync {
  const filePath = resolveDbFilePath(options, options.env ?? process.env);
  mkdirSync(path.dirname(filePath), { recursive: true });

  const db = new DatabaseSync(filePath);

  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`);

  migrate(db);

  return db;
}

function currentUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

/**
 * Apply every migration in {@link MIGRATIONS} not yet reflected in
 * `PRAGMA user_version`. Each migration runs inside its own transaction:
 * on failure the transaction (and that migration's partial schema
 * change) is rolled back and the error rethrown, leaving `user_version`
 * at the last successfully-applied migration.
 */
function migrate(db: DatabaseSync): void {
  const startVersion = currentUserVersion(db);

  for (let version = startVersion; version < MIGRATIONS.length; version++) {
    const sql = MIGRATIONS[version] as string;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      // PRAGMA user_version does not accept a bound parameter; the value
      // here is this module's own loop counter, never external input.
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
