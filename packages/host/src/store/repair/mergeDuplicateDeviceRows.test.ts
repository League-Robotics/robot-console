import { describe, expect, it } from "vitest";
import { openStoreDb } from "../db.js";
import { Store } from "../index.js";
import { mergeDuplicateDeviceRows } from "./mergeDuplicateDeviceRows.js";

/** A fresh in-memory, fully-migrated store for one test. */
function freshStore(): Store {
  return new Store(openStoreDb({ filePath: ":memory:" }));
}

describe("mergeDuplicateDeviceRows (018-006)", () => {
  it("merges the stakeholder's exact gopiv shape: placeholder 1461/owned 1 with links, real 2175407711/owned 0", () => {
    const store = freshStore();
    try {
      // Placeholder -- seeded the way `importKnownRobots` seeds it:
      // `id === nameToValue("gopiv")`, `kind: "robot"`, `owned: 1`.
      store.upsertDevice({ id: 1461, name: "gopiv", kind: "robot", usbSerial: "placeholder-serial", at: 100 });
      store.setOwned(1461, true, 100);
      // Links/sightings hanging off the placeholder, per the live-evidenced shape.
      store.upsertLink({ id: "mbserial-gopiv", transport: "mbserial", address: { host: "loki.local", port: 37317 }, deviceId: 1461, at: 100 });
      store.upsertLink({ id: "radio-gopiv-via-usb-relay", transport: "radio", address: { relayLinkId: "usb-relay" }, deviceId: 1461, at: 100 });
      store.recordSighting({ deviceId: 1461, transport: "radio", viaLinkId: "radio-gopiv-via-usb-relay", at: 100, ok: true });

      // Real row -- chip-id identified since, `owned: 0` (un-owned
      // because every link is still pointed at the placeholder).
      store.upsertDevice({ id: 2175407711, name: "gopiv", kind: "robot", at: 200 });

      mergeDuplicateDeviceRows(store, 300);

      const devices = store.snapshotRows().devices as Array<Record<string, unknown>>;
      const gopivRows = devices.filter((d) => d.name === "gopiv");
      expect(gopivRows).toHaveLength(1);
      const merged = gopivRows[0]!;
      expect(merged.id).toBe(2175407711);
      expect(merged.owned).toBe(1);
      expect(merged.usb_serial).toBe("placeholder-serial");

      const links = store.snapshotRows().links as Array<Record<string, unknown>>;
      expect(links.find((l) => l.id === "mbserial-gopiv")?.device_id).toBe(2175407711);
      expect(links.find((l) => l.id === "radio-gopiv-via-usb-relay")?.device_id).toBe(2175407711);

      const radioSightings = store.radioSightings();
      expect(radioSightings).toEqual([{ deviceId: 2175407711, at: 100 }]);
    } finally {
      store.close();
    }
  });

  it("is idempotent -- a second run on an already-repaired store makes no changes and does not error", () => {
    const store = freshStore();
    try {
      store.upsertDevice({ id: 1461, name: "gopiv", kind: "robot", at: 100 });
      store.setOwned(1461, true, 100);
      store.upsertDevice({ id: 2175407711, name: "gopiv", kind: "robot", at: 200 });

      mergeDuplicateDeviceRows(store, 300);
      const afterFirst = store.snapshotRows().devices;
      expect(afterFirst).toHaveLength(1);

      expect(() => mergeDuplicateDeviceRows(store, 400)).not.toThrow();
      const afterSecond = store.snapshotRows().devices;
      expect(afterSecond).toHaveLength(1);
      expect(afterSecond[0]).toMatchObject({ id: 2175407711, owned: 1 });
    } finally {
      store.close();
    }
  });

  it("leaves a placeholder with no matching real row alone", () => {
    const store = freshStore();
    try {
      // tovez never re-identified since import -- only the placeholder exists.
      store.upsertDevice({ id: 2665, name: "tovez", kind: "robot", at: 100 });
      store.setOwned(2665, true, 100);

      mergeDuplicateDeviceRows(store, 300);

      const devices = store.snapshotRows().devices as Array<Record<string, unknown>>;
      expect(devices).toHaveLength(1);
      expect(devices[0]).toMatchObject({ id: 2665, name: "tovez", owned: 1 });
    } finally {
      store.close();
    }
  });

  it("never merges a relay row into a robot placeholder, even one sharing the placeholder's name", () => {
    const store = freshStore();
    try {
      // A robot placeholder ("vevov", 1031 == nameToValue("vevov")) with
      // only a same-named *relay* row in the store -- a relay is never
      // counted as this placeholder's "real" match, regardless of name.
      // (`id: -1` is the synthetic negative-id convention
      // `mdnsWatcher.ts`'s relay rows use, which skips upsertDevice's own
      // name-consistency assertion for relay rows -- see store/index.ts's
      // own doc comment, "narrowed 2026-09-12 (ticket 017-005)".)
      store.upsertDevice({ id: 1031, name: "vevov", kind: "robot", at: 100 });
      store.setOwned(1031, true, 100);
      store.upsertDevice({ id: -1, name: "vevov", kind: "relay", at: 200 });

      mergeDuplicateDeviceRows(store, 300);

      const devices = store.snapshotRows().devices as Array<Record<string, unknown>>;
      expect(devices).toHaveLength(2);
      expect(devices.find((d) => d.kind === "relay")).toMatchObject({ id: -1 });
      expect(devices.find((d) => d.kind === "robot")).toMatchObject({ id: 1031, owned: 1 });
    } finally {
      store.close();
    }
  });

  it("never merges two real (non-placeholder) rows sharing a name -- ambiguous, left alone", () => {
    const store = freshStore();
    try {
      // Neither row's id is nameToValue("gopiv") (1461) -- both are
      // "real" (chip-id) rows that happen to decode to the same
      // five-letter name (2175407711 and 2175407711 + NAME_SPACE both
      // decode to "gopiv" via deviceIdToName's mod-3125 digits); this
      // repair must not guess which is right, same as
      // `placeholderMerge.ts`'s own documented scope.
      store.upsertDevice({ id: 2175407711, name: "gopiv", kind: "robot", at: 100 });
      store.upsertDevice({ id: 2175407711 + 3125, name: "gopiv", kind: "robot", at: 200 });

      mergeDuplicateDeviceRows(store, 300);

      const devices = store.snapshotRows().devices as Array<Record<string, unknown>>;
      expect(devices).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("repairs more than one duplicated name in a single pass", () => {
    const store = freshStore();
    try {
      store.upsertDevice({ id: 1461, name: "gopiv", kind: "robot", at: 100 });
      store.setOwned(1461, true, 100);
      store.upsertDevice({ id: 2175407711, name: "gopiv", kind: "robot", at: 200 });

      store.upsertDevice({ id: 2665, name: "tovez", kind: "robot", at: 100 });
      store.setOwned(2665, true, 100);
      store.upsertDevice({ id: 2314287040, name: "tovez", kind: "robot", at: 200 });

      mergeDuplicateDeviceRows(store, 300);

      const devices = store.snapshotRows().devices as Array<Record<string, unknown>>;
      expect(devices).toHaveLength(2);
      expect(devices.find((d) => d.name === "gopiv")).toMatchObject({ id: 2175407711, owned: 1 });
      expect(devices.find((d) => d.name === "tovez")).toMatchObject({ id: 2314287040, owned: 1 });
    } finally {
      store.close();
    }
  });
});
