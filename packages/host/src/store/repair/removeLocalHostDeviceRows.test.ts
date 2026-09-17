import os from "node:os";
import { describe, expect, it } from "vitest";
import { openStoreDb } from "../db.js";
import { Store } from "../index.js";
import { removeLocalHostDeviceRows } from "./removeLocalHostDeviceRows.js";

/** A fresh in-memory, fully-migrated store for one test. */
function freshStore(): Store {
  return new Store(openStoreDb({ filePath: ":memory:" }));
}

describe("removeLocalHostDeviceRows (018-010, item 2)", () => {
  it("removes a kind='relay' device row whose name is this machine's own hostname, and every link that pointed at it", () => {
    const store = freshStore();
    try {
      const hostname = os.hostname();
      store.upsertDevice({ id: -1234, name: hostname, kind: "relay", at: 100 });
      store.upsertLink({
        id: `mbrelay-${hostname}`,
        transport: "mbrelay",
        address: { host: `${hostname}.local`, port: 8760 },
        deviceId: -1234,
        at: 100,
      });

      removeLocalHostDeviceRows(store);

      const rows = store.snapshotRows();
      expect(rows.devices.find((d) => d.id === -1234)).toBeUndefined();
      expect(rows.links.find((l) => l.id === `mbrelay-${hostname}`)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("matches case-insensitively and tolerates a '.local'/'.local.' suffix on the device's own name", () => {
    const store = freshStore();
    try {
      const hostname = os.hostname().toUpperCase();
      store.upsertDevice({ id: -1235, name: `${hostname}.local`, kind: "relay", at: 100 });

      removeLocalHostDeviceRows(store);

      expect(store.snapshotRows().devices.find((d) => d.id === -1235)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("never touches a relay device row named after a different machine", () => {
    const store = freshStore();
    try {
      store.upsertDevice({ id: -999999, name: "torture", kind: "relay", at: 100 });

      removeLocalHostDeviceRows(store);

      expect(store.snapshotRows().devices.find((d) => d.id === -999999)).toBeDefined();
    } finally {
      store.close();
    }
  });

  it("never touches a kind='robot' device row, whatever its name -- restricted to kind='relay' by construction (see this module's own doc comment: a robot's name is always a well-formed five-letter grammar name, which a real machine hostname can never collide with)", () => {
    const store = freshStore();
    try {
      const robotId = 536019796; // deviceIdToName(536019796) === "vevav"
      store.upsertDevice({ id: robotId, name: "vevav", kind: "robot", at: 100 });

      removeLocalHostDeviceRows(store);

      expect(store.snapshotRows().devices.find((d) => d.id === robotId)).toBeDefined();
    } finally {
      store.close();
    }
  });

  it("is idempotent -- a second run finds nothing left to remove", () => {
    const store = freshStore();
    try {
      const hostname = os.hostname();
      store.upsertDevice({ id: -1237, name: hostname, kind: "relay", at: 100 });

      removeLocalHostDeviceRows(store);
      expect(() => removeLocalHostDeviceRows(store)).not.toThrow();
      expect(store.snapshotRows().devices.find((d) => d.id === -1237)).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
