import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_BUSY_TIMEOUT_MS, openReadOnlyStoreDb, openStoreDb, resolveDbFilePath } from "./db.js";

/** Every table architecture.md §4 defines, in the order it defines
 * them. */
const EXPECTED_TABLES = [
  "devices",
  "links",
  "services",
  "sightings",
  "sessions",
  "board_owner",
  "relay_leases",
  "firmware",
  "settings",
  "tasks",
  "changes",
  "agent_actions",
] as const;

const EXPECTED_INDEXES = [
  "devices_name",
  "links_device",
  "sightings_device_at",
  "agent_actions_link",
  "agent_actions_device",
] as const;

function listNames(db: DatabaseSync, type: "table" | "index"): string[] {
  // Excludes SQLite's own internal autoindexes (`sqlite_autoindex_*`,
  // created implicitly for TEXT/composite PRIMARY KEY constraints) --
  // this asserts only what the migration itself declares.
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = ?").all(type) as Array<{ name: string }>)
    .map((row) => row.name)
    .filter((name) => !name.startsWith("sqlite_"))
    .sort();
}

function columnNames(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

describe("store/db: resolveDbFilePath", () => {
  it("uses an explicit filePath as-is, ignoring stateDir/env", () => {
    expect(resolveDbFilePath({ filePath: "/explicit/console.sqlite", stateDir: "/other" }, {})).toBe(
      "/explicit/console.sqlite",
    );
  });

  it("joins an explicit stateDir with console.sqlite", () => {
    expect(resolveDbFilePath({ stateDir: "/some/state/dir" }, {})).toBe(
      path.join("/some/state/dir", "console.sqlite"),
    );
  });

  it("falls back to ROBOT_CONSOLE_STATE_DIR, then XDG_STATE_HOME/robot-console", () => {
    expect(resolveDbFilePath({}, { ROBOT_CONSOLE_STATE_DIR: "/override" })).toBe(
      path.join("/override", "console.sqlite"),
    );
    expect(resolveDbFilePath({}, { XDG_STATE_HOME: "/xdg" })).toBe(
      path.join("/xdg", "robot-console", "console.sqlite"),
    );
  });
});

describe("store/db: openStoreDb", () => {
  let dir: string;
  let dbFile: string;
  let db: DatabaseSync | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "robot-console-store-test-"));
    dbFile = path.join(dir, "console.sqlite");
  });

  afterEach(() => {
    db?.close();
    db = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates console.sqlite in a nested, not-yet-existing directory", () => {
    const nested = path.join(dir, "a", "b");
    const nestedFile = path.join(nested, "console.sqlite");
    db = openStoreDb({ filePath: nestedFile });
    db.close();
    db = undefined;
    // A fresh open against the same path must not throw and must find
    // the directory already there.
    db = openStoreDb({ filePath: nestedFile });
  });

  it("opens in WAL journal mode with the configured busy_timeout", () => {
    db = openStoreDb({ filePath: dbFile, busyTimeoutMs: 1234 });
    const journalMode = (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
    expect(journalMode).toBe("wal");
    const busyTimeout = (db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout;
    expect(busyTimeout).toBe(1234);
  });

  it("defaults busy_timeout when none is given", () => {
    db = openStoreDb({ filePath: dbFile });
    const busyTimeout = (db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout;
    expect(busyTimeout).toBe(DEFAULT_BUSY_TIMEOUT_MS);
  });

  it("migrates a fresh database (user_version 0) to create every table and index", () => {
    db = openStoreDb({ filePath: dbFile });

    // Sprint 018 ticket 010 added migration 0002 (`sessions.answered_at`),
    // ticket 016 added migration 0003 (`devices.common_name`), sprint 019
    // ticket 005 added migration 0004 (`sessions.origin`/`sessions.caller`),
    // and ticket 006 added migration 0005 (`agent_actions`) alongside
    // 0001 -- a fresh database now lands on user_version 5.
    const userVersion = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(userVersion).toBe(5);

    expect(listNames(db, "table")).toEqual([...EXPECTED_TABLES].sort());
    expect(listNames(db, "index")).toEqual([...EXPECTED_INDEXES].sort());
  });

  it("matches architecture.md §4's columns for devices and links exactly", () => {
    db = openStoreDb({ filePath: dbFile });

    expect(columnNames(db, "devices")).toEqual([
      "id",
      "name",
      "kind",
      "role",
      "program",
      "version",
      "usb_serial",
      "radio_channel",
      "radio_group",
      "radio_source",
      "owned",
      "first_seen",
      "last_seen",
      "common_name",
    ]);

    expect(columnNames(db, "links")).toEqual([
      "id",
      "device_id",
      "transport",
      "address",
      "state",
      "state_reason",
      "state_since",
      "last_seen",
      "next_retry_at",
      "fail_count",
      "user_closed",
    ]);
  });

  it("is idempotent: re-opening an already-migrated database is a no-op", () => {
    db = openStoreDb({ filePath: dbFile });
    db.close();

    db = openStoreDb({ filePath: dbFile });
    const userVersion = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(userVersion).toBe(5);
    expect(listNames(db, "table")).toEqual([...EXPECTED_TABLES].sort());

    // Insert a row, close, and re-open again -- a second migration pass
    // must never touch existing data (e.g. by attempting to re-create a
    // table that already exists).
    db.exec(
      "INSERT INTO devices (id, name, kind, owned, first_seen, last_seen) VALUES (1, 'abcde', 'robot', 1, 100, 100)",
    );
    db.close();

    db = openStoreDb({ filePath: dbFile });
    const row = db.prepare("SELECT name FROM devices WHERE id = 1").get() as { name: string } | undefined;
    expect(row?.name).toBe("abcde");
  });
});

describe("store/db: openReadOnlyStoreDb", () => {
  let dir: string;
  let dbFile: string;
  let db: DatabaseSync | undefined;
  let readOnlyDb: DatabaseSync | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "robot-console-store-readonly-test-"));
    dbFile = path.join(dir, "console.sqlite");
  });

  afterEach(() => {
    readOnlyDb?.close();
    readOnlyDb = undefined;
    db?.close();
    db = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined for a console.sqlite that does not exist yet -- never creates it", () => {
    readOnlyDb = openReadOnlyStoreDb({ filePath: dbFile });
    expect(readOnlyDb).toBeUndefined();
    // Confirm "never creates it" isn't just an unchecked assumption.
    expect(existsSync(dbFile)).toBe(false);
  });

  it("opens an existing database with the configured busy_timeout", () => {
    db = openStoreDb({ filePath: dbFile });
    db.close();
    db = undefined;

    readOnlyDb = openReadOnlyStoreDb({ filePath: dbFile, busyTimeoutMs: 4321 });
    expect(readOnlyDb).toBeDefined();
    const busyTimeout = (readOnlyDb!.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout;
    expect(busyTimeout).toBe(4321);
  });

  it("ships no write path: an INSERT against the read-only connection throws", () => {
    db = openStoreDb({ filePath: dbFile });
    db.close();
    db = undefined;

    readOnlyDb = openReadOnlyStoreDb({ filePath: dbFile });
    expect(() =>
      readOnlyDb!.exec(
        "INSERT INTO devices (id, name, kind, owned, first_seen, last_seen) VALUES (1, 'abcde', 'robot', 1, 100, 100)",
      ),
    ).toThrow();
  });

  it("reads successfully while a second connection holds an open write transaction (WAL, no block/error)", () => {
    db = openStoreDb({ filePath: dbFile });
    // Hold a write transaction open on the primary (writable) connection
    // without committing it yet -- exactly the "host process currently
    // running, mid-write" scenario SUC-006's acceptance criteria and
    // this ticket's own testing section call out.
    db.exec("BEGIN IMMEDIATE");
    db.exec(
      "INSERT INTO devices (id, name, kind, owned, first_seen, last_seen) VALUES (1, 'abcde', 'robot', 1, 100, 100)",
    );

    readOnlyDb = openReadOnlyStoreDb({ filePath: dbFile });
    expect(readOnlyDb).toBeDefined();
    // Must not throw and must not hang -- a synchronous call returning
    // at all (within the test's own timeout) demonstrates no block.
    expect(() => readOnlyDb!.prepare("SELECT * FROM devices").all()).not.toThrow();

    db.exec("COMMIT");
  });
});
