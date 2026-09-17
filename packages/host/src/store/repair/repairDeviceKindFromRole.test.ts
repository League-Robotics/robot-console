import { nameToValue } from "@robot-console/protocol";
import { describe, expect, it } from "vitest";
import { openStoreDb } from "../db.js";
import { Store } from "../index.js";
import { repairDeviceKindFromRole } from "./repairDeviceKindFromRole.js";

/** A fresh in-memory, fully-migrated store for one test. */
function freshStore(): Store {
  return new Store(openStoreDb({ filePath: ":memory:" }));
}

const ZUVEG_ID = nameToValue("zuveg");

describe("repairDeviceKindFromRole (018-010)", () => {
  it("promotes the stakeholder's exact vevav shape: kind 'robot' with role 'RADIOBRIDGE'", () => {
    const store = freshStore();
    try {
      store.upsertDevice({ id: 536019796, name: "vevav", kind: "robot", role: "RADIOBRIDGE", at: 100 });

      repairDeviceKindFromRole(store);

      const device = store.snapshotRows().devices.find((d) => d.id === 536019796);
      expect(device?.kind).toBe("relay");
      expect(device?.role).toBe("RADIOBRIDGE");
    } finally {
      store.close();
    }
  });

  it("promotes a RADIORELAY role the same way", () => {
    const store = freshStore();
    try {
      store.upsertDevice({ id: ZUVEG_ID, name: "zuveg", kind: "robot", role: "RADIORELAY", at: 100 });
      repairDeviceKindFromRole(store);
      expect(store.snapshotRows().devices.find((d) => d.id === ZUVEG_ID)?.kind).toBe("relay");
    } finally {
      store.close();
    }
  });

  it("leaves a real robot role (e.g. NEZHA2) alone", () => {
    const store = freshStore();
    try {
      store.upsertDevice({ id: 2175407711, name: "gopiv", kind: "robot", role: "NEZHA2", at: 100 });
      repairDeviceKindFromRole(store);
      expect(store.snapshotRows().devices.find((d) => d.id === 2175407711)?.kind).toBe("robot");
    } finally {
      store.close();
    }
  });

  it("leaves a device with no role at all alone (never guesses)", () => {
    const store = freshStore();
    try {
      store.upsertDevice({ id: ZUVEG_ID, name: "zuveg", kind: "robot", at: 100 });
      repairDeviceKindFromRole(store);
      expect(store.snapshotRows().devices.find((d) => d.id === ZUVEG_ID)?.kind).toBe("robot");
    } finally {
      store.close();
    }
  });

  it("never touches an already-correct relay row, whatever its role", () => {
    const store = freshStore();
    try {
      store.upsertDevice({ id: -1, name: "torture", kind: "relay", at: 100 });
      repairDeviceKindFromRole(store);
      expect(store.snapshotRows().devices.find((d) => d.id === -1)?.kind).toBe("relay");
    } finally {
      store.close();
    }
  });

  it("is idempotent -- a second run makes no further changes", () => {
    const store = freshStore();
    try {
      store.upsertDevice({ id: 536019796, name: "vevav", kind: "robot", role: "RADIOBRIDGE", at: 100 });
      repairDeviceKindFromRole(store);
      expect(() => repairDeviceKindFromRole(store)).not.toThrow();
      expect(store.snapshotRows().devices.find((d) => d.id === 536019796)?.kind).toBe("relay");
    } finally {
      store.close();
    }
  });
});
