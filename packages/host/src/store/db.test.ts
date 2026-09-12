import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_BUSY_TIMEOUT_MS, openStoreDb, resolveDbFilePath } from "./db.js";

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
] as const;

const EXPECTED_INDEXES = ["devices_name", "links_device", "sightings_device_at"] as const;

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

    const userVersion = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(userVersion).toBe(1);

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
    expect(userVersion).toBe(1);
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
