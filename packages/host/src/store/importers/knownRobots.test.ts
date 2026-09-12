import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openStoreDb } from "../db.js";
import { Store } from "../index.js";
import { importKnownRobots } from "./knownRobots.js";

const FIXTURES_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "__fixtures__");
const FIXTURE_PATH = path.join(FIXTURES_DIR, "known-robots.json");
const FIXTURE_ROBOT_COUNT = (JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as { robots: unknown[] }).robots.length;

function freshStore(): { store: Store; db: DatabaseSync } {
  const db = openStoreDb({ filePath: ":memory:" });
  return { store: new Store(db), db };
}

describe("importKnownRobots", () => {
  it("imports every fixture record as an owned devices row (SUC-005)", () => {
    const { store } = freshStore();
    try {
      const result = importKnownRobots(store, FIXTURE_PATH);
      expect(result.imported).toBe(FIXTURE_ROBOT_COUNT);

      const rows = store.snapshotRows().devices;
      expect(rows).toHaveLength(FIXTURE_ROBOT_COUNT);
      expect(rows.every((row) => row.owned === 1 && row.kind === "robot")).toBe(true);

      const names = rows.map((row) => row.name).sort();
      expect(names).toEqual(["gatav", "tovez", "vevov"]);
    } finally {
      store.close();
    }
  });

  it("is idempotent: a second call imports nothing and leaves the row count unchanged", () => {
    const { store } = freshStore();
    try {
      importKnownRobots(store, FIXTURE_PATH);
      const second = importKnownRobots(store, FIXTURE_PATH);
      expect(second.imported).toBe(0);
      expect(store.snapshotRows().devices).toHaveLength(FIXTURE_ROBOT_COUNT);
    } finally {
      store.close();
    }
  });

  it("leaves the fixture file itself untouched", () => {
    const before = readFileSync(FIXTURE_PATH, "utf8");
    const { store } = freshStore();
    try {
      importKnownRobots(store, FIXTURE_PATH);
      const after = readFileSync(FIXTURE_PATH, "utf8");
      expect(after).toBe(before);
    } finally {
      store.close();
    }
  });

  it("carries lastUsbSerial/lastRole onto the device row as display hints", () => {
    const { store } = freshStore();
    try {
      importKnownRobots(store, FIXTURE_PATH);
      const vevov = store.snapshotRows().devices.find((row) => row.name === "vevov");
      expect(vevov).toMatchObject({ usb_serial: "0012345678", role: "NEZHA2" });
    } finally {
      store.close();
    }
  });

  it("does nothing and does not set the guard when the file does not exist", () => {
    const { store } = freshStore();
    try {
      const result = importKnownRobots(store, "/no/such/known-robots.json");
      expect(result.imported).toBe(0);
      expect(store.snapshotRows().devices).toHaveLength(0);

      // a later call, once the file exists, must still import -- proven
      // via injected deps rather than a real file for determinism.
      const again = importKnownRobots(store, FIXTURE_PATH);
      expect(again.imported).toBe(FIXTURE_ROBOT_COUNT);
    } finally {
      store.close();
    }
  });

  it("treats corrupt JSON as never-fatal: imports nothing, sets no guard", () => {
    const { store } = freshStore();
    try {
      const result = importKnownRobots(store, "/irrelevant/path.json", {
        existsSync: () => true,
        readFileSync: () => "{not valid json",
      });
      expect(result.imported).toBe(0);
      expect(store.snapshotRows().devices).toHaveLength(0);

      // guard not set -- a subsequent call against good data still imports
      const again = importKnownRobots(store, FIXTURE_PATH);
      expect(again.imported).toBe(FIXTURE_ROBOT_COUNT);
    } finally {
      store.close();
    }
  });
});
