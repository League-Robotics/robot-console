/**
 * bootstrap.test.ts — `openStoreWithImports` (ticket 014-010, the fix
 * for the SUC-005 gap the ticket's own bench pass found: the importers
 * existed with zero production call sites). Uses a fresh temp directory
 * as the state dir, exactly the way `db.test.ts` already does, so no
 * real `~/.local/state/robot-console` is ever touched.
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStoreWithImports } from "./bootstrap.js";

const FIXTURES_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "__fixtures__");
const FIXTURE_PATH = path.join(FIXTURES_DIR, "known-robots.json");
const FIXTURE_ROBOT_COUNT = (JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as { robots: unknown[] }).robots.length;

describe("openStoreWithImports", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "robot-console-bootstrap-test-"));
    copyFileSync(FIXTURE_PATH, path.join(dir, "known-robots.json"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("imports known-robots.json's entries as owned=1 device rows before any watcher runs (SUC-005)", () => {
    const store = openStoreWithImports({ stateDir: dir });
    try {
      const devices = store.snapshotRows().devices;
      const ownedCount = devices.filter((row) => row.owned === 1).length;
      expect(ownedCount).toBe(FIXTURE_ROBOT_COUNT);
      expect(devices).toHaveLength(FIXTURE_ROBOT_COUNT);
    } finally {
      store.close();
    }
  });

  it("is a no-op on a second bootstrap against the same state dir", () => {
    const first = openStoreWithImports({ stateDir: dir });
    const firstCount = first.snapshotRows().devices.length;
    first.close();

    const second = openStoreWithImports({ stateDir: dir });
    try {
      const devices = second.snapshotRows().devices;
      expect(devices).toHaveLength(firstCount);
      expect(devices.filter((row) => row.owned === 1)).toHaveLength(FIXTURE_ROBOT_COUNT);
    } finally {
      second.close();
    }
  });

  it("does not fail when known-robots.json/wifi-credentials.json are absent", () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), "robot-console-bootstrap-empty-test-"));
    try {
      const store = openStoreWithImports({ stateDir: emptyDir });
      try {
        expect(store.snapshotRows().devices).toHaveLength(0);
      } finally {
        store.close();
      }
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
