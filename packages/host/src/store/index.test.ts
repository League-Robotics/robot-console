import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { nameToValue } from "@robot-console/protocol";
import { openStoreDb } from "./db.js";
import { DeviceNameMismatchError, Store, openStore, type ChangeEvent } from "./index.js";

/** A fresh in-memory, fully-migrated store for one test. Also returns
 * the raw `db` handle -- legitimate here (this file lives in `store/`,
 * the one directory the "no SQL outside store/" rule allows it in) so
 * tests can assert directly on tables {@link Store.snapshotRows} does
 * not expose (`sightings`, `board_owner`, `relay_leases`, `firmware`). */
function freshStore(): { store: Store; db: DatabaseSync } {
  const db: DatabaseSync = openStoreDb({ filePath: ":memory:" });
  return { store: new Store(db), db };
}

/** Waits for the change feed's coalesced flush (`setImmediate`) to run. */
function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("Store: upsertDevice", () => {
  it("creates a device row, preserving first_seen and updating last_seen on a later call", () => {
    const { store } = freshStore();
    try {
      store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 100 });
      let rows = store.snapshotRows().devices;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: 1198504156, name: "vevov", kind: "robot", owned: 0, first_seen: 100, last_seen: 100 });

      store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", role: "NEZHA2", at: 200 });
      rows = store.snapshotRows().devices;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ first_seen: 100, last_seen: 200, role: "NEZHA2" });
    } finally {
      store.close();
    }
  });

  it("never touches owned -- that is setOwned's job alone", () => {
    const { store } = freshStore();
    try {
      store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 100 });
      store.setOwned(1198504156, true, 150);
      store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", role: "NEZHA2", at: 200 });
      const row = store.snapshotRows().devices[0];
      expect(row?.owned).toBe(1);
    } finally {
      store.close();
    }
  });

  it("preserves an existing optional field when a later call omits it (COALESCE)", () => {
    const { store } = freshStore();
    try {
      store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", usbSerial: "abc123", at: 100 });
      store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 200 });
      expect(store.snapshotRows().devices[0]?.usb_serial).toBe("abc123");
    } finally {
      store.close();
    }
  });

  // 018-016: `common_name` (from the banner's `commonName`, written
  // alongside `role`) follows the same COALESCE discipline as every
  // other optional column here -- an identify that doesn't carry a
  // common name (or a caller that omits it entirely) must never
  // clobber an already-known value with null.
  it("writes commonName from a banner-identify call and never overwrites a known value with a later omitted/null one", () => {
    const { store } = freshStore();
    try {
      store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", role: "NEZHA2", commonName: "robot", at: 100 });
      expect(store.snapshotRows().devices[0]?.common_name).toBe("robot");

      // A later upsert that omits commonName entirely (optional field) --
      // COALESCE keeps the existing value.
      store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", role: "NEZHA2", at: 200 });
      expect(store.snapshotRows().devices[0]?.common_name).toBe("robot");

      // A later upsert that explicitly passes commonName: null -- same
      // COALESCE rule applies (null is the SQL "no value" signal, not a
      // request to clear the column).
      store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", role: "NEZHA2", commonName: null, at: 300 });
      expect(store.snapshotRows().devices[0]?.common_name).toBe("robot");
    } finally {
      store.close();
    }
  });

  it("refuses a deviceIdToName(id) !== name mismatch with a typed error (RADIOBRIDGE fixture, protocol review §2 item 6)", () => {
    const { store } = freshStore();
    try {
      // banner.test.ts:5-16 -- id 1779042496 actually decodes to "gatav",
      // not the fixture's "getez".
      expect(() => store.upsertDevice({ id: 1779042496, name: "getez", kind: "relay", at: 1 })).toThrow(
        DeviceNameMismatchError,
      );
      expect(store.snapshotRows().devices).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("accepts the NEZHA2 fixture, whose id/name are consistent", () => {
    const { store } = freshStore();
    try {
      expect(() => store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 1 })).not.toThrow();
    } finally {
      store.close();
    }
  });

  // 018-004: `kind` is optional -- omitting it means "I don't know yet"
  // (see this module's own "kind is never guessed" doc comment). The
  // bug this closes: `watchers/usbWatcher.ts`'s SWD-naming step used to
  // pass `kind: "robot"` unconditionally, silently downgrading an
  // already-known relay the next time it was seen over USB.
  it("omitting kind on conflict keeps the row's existing kind unchanged (never overwrites a known relay)", () => {
    const { store } = freshStore();
    try {
      store.upsertDevice({ id: 1198504156, name: "vevov", kind: "relay", role: "RADIOBRIDGE", at: 100 });
      store.upsertDevice({ id: 1198504156, name: "vevov", usbSerial: "abc123", at: 200 });
      const row = store.snapshotRows().devices[0];
      expect(row).toMatchObject({ kind: "relay", role: "RADIOBRIDGE", usb_serial: "abc123", last_seen: 200 });
    } finally {
      store.close();
    }
  });

  it("omitting kind on a brand-new row still gets the schema's own required-column default ('robot'), not an assertion the caller made", () => {
    const { store } = freshStore();
    try {
      store.upsertDevice({ id: 1198504156, name: "vevov", usbSerial: "abc123", at: 100 });
      const row = store.snapshotRows().devices[0];
      expect(row).toMatchObject({ id: 1198504156, name: "vevov", kind: "robot" });
    } finally {
      store.close();
    }
  });

  it("an explicit kind on conflict still overwrites, exactly as before (the connector's own identify, mDNS relay discovery, known-robots import)", () => {
    const { store } = freshStore();
    try {
      store.upsertDevice({ id: 1198504156, name: "vevov", at: 100 });
      store.upsertDevice({ id: 1198504156, name: "vevov", kind: "relay", role: "RADIOBRIDGE", at: 200 });
      expect(store.snapshotRows().devices[0]).toMatchObject({ kind: "relay", role: "RADIOBRIDGE" });
    } finally {
      store.close();
    }
  });
});

describe("Store: getDeviceKind", () => {
  it("returns the stored kind for an existing row", () => {
    const { store } = freshStore();
    try {
      store.upsertDevice({ id: 1198504156, name: "vevov", kind: "relay", at: 1 });
      expect(store.getDeviceKind(1198504156)).toBe("relay");
    } finally {
      store.close();
    }
  });

  it("returns undefined when no row exists yet", () => {
    const { store } = freshStore();
    try {
      expect(store.getDeviceKind(1198504156)).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------
// Ticket 017-005 (2026-09-12 architecture revision): the
// `deviceIdToName(id) === name` check is narrowed to skip evaluation
// only when `id < 0 && kind === 'relay'` -- negative ids are never real
// chip ids (`FICR.DEVICEID[1]` is unsigned 32-bit), so they are
// unambiguously synthetic (mdnsWatcher.ts's hash-derived fallback for a
// non-grammar mDNS relay name). Every other row shape still enforces
// the check exactly as before -- this table exercises both the new
// narrowed case and the still-enforced cases side by side.
// ---------------------------------------------------------------------
describe("Store: upsertDevice name/id invariant narrowing (ticket 017-005)", () => {
  it.each([
    ["negative id + non-grammar name + kind='relay' -> accepted", -1, "torture", "relay" as const, false],
    ["negative id + non-grammar name + kind='robot' -> still throws", -1, "torture", "robot" as const, true],
    // The existing 014-003 mismatch fixture (protocol review §2 item 6):
    // a positive/chip id paired with a mismatched name still throws,
    // whichever kind is supplied -- the narrowing never touches a
    // non-negative id.
    ["positive chip id + mismatched name + kind='relay' -> still throws (014-003 fixture)", 1779042496, "getez", "relay" as const, true],
    ["positive chip id + mismatched name + kind='robot' -> still throws (014-003 fixture)", 1779042496, "getez", "robot" as const, true],
  ] as const)("%s", (_label, id, name, kind, shouldThrow) => {
    const { store } = freshStore();
    try {
      if (shouldThrow) {
        expect(() => store.upsertDevice({ id, name, kind, at: 1 })).toThrow(DeviceNameMismatchError);
        expect(store.snapshotRows().devices).toHaveLength(0);
      } else {
        expect(() => store.upsertDevice({ id, name, kind, at: 1 })).not.toThrow();
        const row = store.snapshotRows().devices.find((r) => r.id === id);
        expect(row).toMatchObject({ id, name, kind });
      }
    } finally {
      store.close();
    }
  });

  it("is idempotent for a repeat observation of the same synthetic negative-id relay", () => {
    const { store } = freshStore();
    try {
      store.upsertDevice({ id: -1, name: "torture", kind: "relay", at: 1 });
      store.upsertDevice({ id: -1, name: "torture", kind: "relay", at: 2 });
      const rows = store.snapshotRows().devices;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: -1, name: "torture", kind: "relay", first_seen: 1, last_seen: 2 });
    } finally {
      store.close();
    }
  });
});

describe("Store: setOwned", () => {
  it("sets owned and refreshes last_seen; is a no-op if the device does not exist", () => {
    const { store } = freshStore();
    try {
      store.setOwned(999, true, 50); // no device row yet
      expect(store.snapshotRows().devices).toHaveLength(0);

      store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 100 });
      store.setOwned(1198504156, true, 150);
      let row = store.snapshotRows().devices[0];
      expect(row?.owned).toBe(1);
      expect(row?.last_seen).toBe(150);

      store.setOwned(1198504156, false, 160);
      row = store.snapshotRows().devices[0];
      expect(row?.owned).toBe(0);
    } finally {
      store.close();
    }
  });
});

describe("Store: setRadioOverride / clearRadioOverride", () => {
  it("sets radio_channel/radio_group and radio_source = 'override'; is a no-op if the device does not exist", () => {
    const { store } = freshStore();
    try {
      store.setRadioOverride(999, 41, 3); // no device row yet
      expect(store.snapshotRows().devices).toHaveLength(0);

      store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 100 });
      store.setRadioOverride(1198504156, 41, 3);
      const row = store.snapshotRows().devices[0];
      expect(row).toMatchObject({ radio_channel: 41, radio_group: 3, radio_source: "override" });
    } finally {
      store.close();
    }
  });

  it("clearRadioOverride returns radio_channel/radio_group/radio_source to NULL", () => {
    const { store } = freshStore();
    try {
      store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 100 });
      store.setRadioOverride(1198504156, 41, 3);
      store.clearRadioOverride(1198504156);
      const row = store.snapshotRows().devices[0];
      expect(row).toMatchObject({ radio_channel: null, radio_group: null, radio_source: null });
    } finally {
      store.close();
    }
  });

  it("clearRadioOverride is a no-op if the device does not exist", () => {
    const { store } = freshStore();
    try {
      expect(() => store.clearRadioOverride(999)).not.toThrow();
      expect(store.snapshotRows().devices).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("persists a radio override across a store close/reopen against the same file (ticket 006 AC1)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "robot-console-radio-override-test-"));
    const filePath = path.join(dir, "console.sqlite");
    try {
      const store1 = new Store(openStoreDb({ filePath }));
      store1.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 100 });
      store1.setRadioOverride(1198504156, 41, 3);
      store1.close();

      const store2 = new Store(openStoreDb({ filePath }));
      try {
        const row = store2.snapshotRows().devices[0];
        expect(row).toMatchObject({ radio_channel: 41, radio_group: 3, radio_source: "override" });
        const projected = store2.projectionRows().devices[0];
        expect(projected).toMatchObject({ radioChannel: 41, radioGroup: 3, radioSource: "override" });
      } finally {
        store2.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("openStore: clears dead-process-owned state on open (018-010)", () => {
  it("a leftover sweep lease / board owner / open session / connecting link none render as live once reopened via openStore()", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "robot-console-dead-process-state-test-"));
    const filePath = path.join(dir, "console.sqlite");
    try {
      // Seed directly (bypassing openStore's own reset) so the on-disk
      // file already carries exactly the shape a real console.sqlite
      // copied from a still-running process would have -- the same
      // seeding style `openStore: runs the one-time duplicate
      // device-row repair` uses below for its own repair.
      const seedStore = new Store(openStoreDb({ filePath }));
      seedStore.upsertLink({ id: "mbrelay-vitut", transport: "mbrelay", address: { host: "vitut.local", port: 8760 }, at: 100 });
      seedStore.acquireRelayLease("mbrelay-vitut", "sweep", 100);
      seedStore.acquireBoardOwner("SERIAL-A", "sweep", 100);
      seedStore.upsertLink({ id: "usb-SERIAL-B", transport: "usb", address: { path: "/dev/b" }, at: 100 });
      seedStore.openSession("usb-SERIAL-B", 100);
      seedStore.upsertLink({ id: "usb-SERIAL-C", transport: "usb", address: { path: "/dev/c" }, at: 100 });
      seedStore.setLinkState({ id: "usb-SERIAL-C", state: "connecting", at: 100 });
      seedStore.close();

      // openStore() (not `new Store(openStoreDb(...))`) is the one
      // production entry point (`store/bootstrap.ts`'s
      // `openStoreWithImports`) -- this asserts the reset actually runs
      // there, not only when called directly in the repair module's
      // own unit tests.
      const store = openStore({ filePath });
      try {
        // Not live: a fresh acquire by "this" process succeeds for both
        // the relay lease and the board owner -- the old owner is gone.
        expect(store.acquireRelayLease("mbrelay-vitut", "sweep", 500)).toBe(true);
        expect(store.acquireBoardOwner("SERIAL-A", "naming", 500)).toBe(true);

        // No open session left rendering as live.
        expect(store.snapshotRows().sessions).toHaveLength(0);

        // The connecting link was reset to connectable, not left
        // looking like an active connection.
        const links = store.snapshotRows().links;
        expect(links.find((l) => l.id === "usb-SERIAL-C")).toMatchObject({ state: "connectable" });
        expect(links.find((l) => l.id === "usb-SERIAL-B")).toMatchObject({ state: "discovered" });
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("openStore: removes a local-host device row on open (018-010, item 2)", () => {
  it("removes a kind='relay' device row (and its links) whose name is this very machine's own hostname", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "robot-console-local-host-repair-test-"));
    const filePath = path.join(dir, "console.sqlite");
    try {
      const hostname = os.hostname();
      // Seed directly (bypassing openStore's own repair) so the on-disk
      // file already carries exactly the shape a real console.sqlite
      // that self-minted before `mdnsWatcher.ts`'s own filter existed
      // would have -- mirrors this file's other repair-wiring tests'
      // own seeding style.
      const seedId = -424242; // an arbitrary negative id -- the same range hashRelayNameToNegativeId uses for a non-grammar name
      const seedStore = new Store(openStoreDb({ filePath }));
      seedStore.upsertDevice({ id: seedId, name: hostname, kind: "relay", at: 100 });
      seedStore.upsertLink({ id: `mbrelay-${hostname}`, transport: "mbrelay", address: { host: `${hostname}.local`, port: 8760 }, deviceId: seedId, at: 100 });
      seedStore.close();

      const store = openStore({ filePath });
      try {
        const rows = store.snapshotRows();
        expect(rows.devices.find((d) => d.id === seedId)).toBeUndefined();
        expect(rows.links.find((l) => l.id === `mbrelay-${hostname}`)).toBeUndefined();
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never touches a relay device row named after a different machine", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "robot-console-local-host-repair-regression-test-"));
    const filePath = path.join(dir, "console.sqlite");
    try {
      const seedStore = new Store(openStoreDb({ filePath }));
      seedStore.upsertDevice({ id: -999999, name: "torture", kind: "relay", at: 100 });
      seedStore.upsertLink({ id: "mbrelay-torture", transport: "mbrelay", address: { host: "torture.local", port: 8760 }, deviceId: -999999, at: 100 });
      seedStore.close();

      const store = openStore({ filePath });
      try {
        const rows = store.snapshotRows();
        expect(rows.devices.find((d) => d.id === -999999)).toBeDefined();
        expect(rows.links.find((l) => l.id === "mbrelay-torture")).toBeDefined();
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("openStore: runs the one-time duplicate device-row repair (018-006)", () => {
  it("merges a placeholder/real device pair on open, before returning the store", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "robot-console-open-repair-test-"));
    const filePath = path.join(dir, "console.sqlite");
    try {
      // Seed the placeholder/real pair directly (bypassing openStore's
      // own repair) so the on-disk file already carries the exact
      // pre-existing-duplicate shape a real, already-affected
      // console.sqlite would have before this ticket's fix ever ran.
      const seedStore = new Store(openStoreDb({ filePath }));
      seedStore.upsertDevice({ id: 1461, name: "gopiv", kind: "robot", at: 100 });
      seedStore.setOwned(1461, true, 100);
      seedStore.upsertDevice({ id: 2175407711, name: "gopiv", kind: "robot", at: 200 });
      seedStore.close();

      // openStore() (not `new Store(openStoreDb(...))`) is the one
      // production entry point (`store/bootstrap.ts`'s
      // `openStoreWithImports`) -- this asserts the repair actually
      // runs there, not only when called directly in the repair
      // module's own unit tests.
      const store = openStore({ filePath });
      try {
        const devices = store.snapshotRows().devices;
        expect(devices).toHaveLength(1);
        expect(devices[0]).toMatchObject({ id: 2175407711, owned: 1 });
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Store: upsertLink / setLinkState / ageLinks", () => {
  it("creates a link in the discovered state and refreshes address/last_seen without touching state", () => {
    const { store } = freshStore();
    try {
      store.upsertLink({ id: "link-1", transport: "usb", address: { path: "/dev/a" }, at: 100 });
      let row = store.snapshotRows().links[0];
      expect(row).toMatchObject({ id: "link-1", state: "discovered", state_since: 100, last_seen: 100 });
      expect(JSON.parse(row?.address as string)).toEqual({ path: "/dev/a" });

      store.setLinkState({ id: "link-1", state: "connectable", at: 150 });
      store.upsertLink({ id: "link-1", transport: "usb", address: { path: "/dev/b" }, at: 200 });
      row = store.snapshotRows().links[0];
      // state untouched by the second upsertLink call
      expect(row?.state).toBe("connectable");
      expect(row?.last_seen).toBe(200);
      expect(JSON.parse(row?.address as string)).toEqual({ path: "/dev/b" });
    } finally {
      store.close();
    }
  });

  it("upsertLink fills in device_id once known and preserves it once set", () => {
    const { store } = freshStore();
    try {
      store.upsertDevice({ id: 42, name: "zuveg", kind: "robot", at: 50 });
      store.upsertLink({ id: "link-1", transport: "usb", address: {}, at: 100 });
      store.upsertLink({ id: "link-1", transport: "usb", address: {}, deviceId: 42, at: 150 });
      expect(store.snapshotRows().links[0]?.device_id).toBe(42);
      // a later call without deviceId must not clear it
      store.upsertLink({ id: "link-1", transport: "usb", address: {}, at: 200 });
      expect(store.snapshotRows().links[0]?.device_id).toBe(42);
    } finally {
      store.close();
    }
  });

  // Ticket 018-010: `upsertLink`'s own write-time guard against a
  // `radio`/`mbrelay` child link's `device_id` disagreeing with the name
  // its own `links.id` encodes (bench defect:
  // `radio-tigez-via-mbrelay-torture` carrying `gopiv`'s own device_id).
  it("upsertLink re-points a radio child link's device_id to the id-named device, regardless of what deviceId was supplied", () => {
    const { store } = freshStore();
    try {
      const tigezId = nameToValue("tigez");
      store.upsertDevice({ id: 1461, name: "gopiv", kind: "robot", at: 50 });
      store.upsertDevice({ id: tigezId, name: "tigez", kind: "robot", at: 50 });
      // Link id names `tigez`; `deviceId` (as a relay-bridge identify
      // might mistakenly supply) names `gopiv` instead.
      store.upsertLink({
        id: "radio-tigez-via-mbrelay-torture",
        transport: "radio",
        address: { relayLinkId: "mbrelay-torture", channel: 55, group: 114 },
        deviceId: 1461,
        at: 100,
      });
      expect(store.snapshotRows().links[0]?.device_id).toBe(tigezId);
    } finally {
      store.close();
    }
  });

  it("upsertLink leaves deviceId as supplied when no device is named by the link id yet (an ordinary first sighting, not a correction)", () => {
    const { store } = freshStore();
    try {
      store.upsertDevice({ id: 1461, name: "gopiv", kind: "robot", at: 50 });
      // No "tigez" device row exists yet -- the write-time guard must
      // not null this out (that stronger rule is the one-time repair's
      // own, `repair/repairRadioLinkDeviceAssociation.ts`).
      store.upsertLink({
        id: "radio-tigez-via-mbrelay-torture",
        transport: "radio",
        address: { relayLinkId: "mbrelay-torture", channel: 55, group: 114 },
        deviceId: 1461,
        at: 100,
      });
      expect(store.snapshotRows().links[0]?.device_id).toBe(1461);
    } finally {
      store.close();
    }
  });

  it("upsertLink never applies the radio-child guard to a plain usb/wifi/mbserial link id", () => {
    const { store } = freshStore();
    try {
      store.upsertDevice({ id: 1461, name: "gopiv", kind: "robot", at: 50 });
      store.upsertLink({ id: "usb-relay-serial", transport: "usb", address: { path: "/dev/cu.a" }, deviceId: 1461, at: 100 });
      expect(store.snapshotRows().links[0]?.device_id).toBe(1461);
    } finally {
      store.close();
    }
  });

  it("setLinkState transitions state/reason and COALESCEs omitted optional fields", () => {
    const { store } = freshStore();
    try {
      store.upsertLink({ id: "link-1", transport: "usb", address: {}, at: 100 });
      store.setLinkState({ id: "link-1", state: "failed", at: 200, reason: "timeout", nextRetryAt: 300, failCount: 1 });
      let row = store.snapshotRows().links[0];
      expect(row).toMatchObject({ state: "failed", state_reason: "timeout", next_retry_at: 300, fail_count: 1 });

      // a later transition that omits failCount must not reset it to 0
      store.setLinkState({ id: "link-1", state: "connecting", at: 250 });
      row = store.snapshotRows().links[0];
      expect(row?.fail_count).toBe(1);
      expect(row?.state).toBe("connecting");
    } finally {
      store.close();
    }
  });

  it("setLinkState sets user_closed and later calls preserve it when omitted", () => {
    const { store } = freshStore();
    try {
      store.upsertLink({ id: "link-1", transport: "usb", address: {}, at: 100 });
      store.setLinkState({ id: "link-1", state: "closed_by_user", at: 200, userClosed: true });
      expect(store.snapshotRows().links[0]?.user_closed).toBe(1);
      store.setLinkState({ id: "link-1", state: "closed_by_user", at: 250 });
      expect(store.snapshotRows().links[0]?.user_closed).toBe(1);
    } finally {
      store.close();
    }
  });

  it("ageLinks marks only links of the given transport past the ttl as stale, and returns the count", () => {
    const { store } = freshStore();
    try {
      store.upsertLink({ id: "usb-old", transport: "usb", address: {}, at: 0 });
      store.upsertLink({ id: "usb-fresh", transport: "usb", address: {}, at: 900 });
      store.upsertLink({ id: "wifi-old", transport: "wifi", address: {}, at: 0 });

      const aged = store.ageLinks("usb", 500, 1000); // cutoff = 500
      expect(aged).toBe(1);

      const rows = store.snapshotRows().links;
      const byId = Object.fromEntries(rows.map((r) => [r.id as string, r.state]));
      expect(byId["usb-old"]).toBe("stale");
      expect(byId["usb-fresh"]).toBe("discovered");
      expect(byId["wifi-old"]).toBe("discovered");
    } finally {
      store.close();
    }
  });

  it("ageLinks is idempotent -- a link already stale is not re-aged (no duplicate changes)", () => {
    const { store } = freshStore();
    try {
      store.upsertLink({ id: "usb-old", transport: "usb", address: {}, at: 0 });
      expect(store.ageLinks("usb", 500, 1000)).toBe(1);
      expect(store.ageLinks("usb", 500, 2000)).toBe(0);
    } finally {
      store.close();
    }
  });

  it("never ages a link with an open session, however stale its own last_seen (ticket 016-008 bench finding: a live mbserial session must never read as stale)", () => {
    const { store } = freshStore();
    try {
      store.upsertLink({ id: "mbserial-gopiv", transport: "mbserial", address: {}, at: 0 });
      store.openSession("mbserial-gopiv", 0);

      // Past the ttl by a wide margin -- would ordinarily age.
      const aged = store.ageLinks("mbserial", 500, 1000);
      expect(aged).toBe(0);
      expect(store.snapshotRows().links.find((l) => l.id === "mbserial-gopiv")?.state).toBe("discovered");
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------
// ageRadioLinks / clearRadioLinkStaleText -- ticket 018-005
// ---------------------------------------------------------------------

describe("Store: ageRadioLinks (018-005)", () => {
  it("ages a radio link past its ttl with no successful sighting, even though last_seen was refreshed by later FAILED attempts", () => {
    const { store } = freshStore();
    try {
      store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 0 });
      store.upsertLink({ id: "usb-relay", transport: "usb", address: { path: "/dev/cu.relay" }, at: 0 });
      store.upsertLink({ id: "radio-gopiv-via-usb-relay", transport: "radio", address: { relayLinkId: "usb-relay", channel: 47, group: 60 }, deviceId: 1198504156, at: 0 });

      // A single successful sighting long ago, then only failures --
      // last_seen (bumped by upsertLink on every attempt, ok or not)
      // stays "fresh" right up to `now`, but there has been no SUCCESS
      // within the ttl. A last_seen-based rule (ageLinks's own) would
      // never catch this -- that's the exact bench-evidenced gap.
      store.recordSighting({ deviceId: 1198504156, transport: "radio", viaLinkId: "usb-relay", at: 0, ok: true });
      store.upsertLink({ id: "radio-gopiv-via-usb-relay", transport: "radio", address: { relayLinkId: "usb-relay", channel: 47, group: 60 }, deviceId: 1198504156, at: 900 });
      store.recordSighting({ deviceId: 1198504156, transport: "radio", viaLinkId: "usb-relay", at: 900, ok: false });

      const aged = store.ageRadioLinks(500, 1000); // cutoff = 500; last ok sighting was at 0
      expect(aged).toBe(1);
      const row = store.snapshotRows().links.find((l) => l.id === "radio-gopiv-via-usb-relay");
      expect(row?.state).toBe("stale");
      expect(row?.state_reason).toBe("ttl-expired");
    } finally {
      store.close();
    }
  });

  it("does not age a radio link with a recent successful sighting, even if it was probed via a relay long ago", () => {
    const { store } = freshStore();
    try {
      store.upsertDevice({ id: 1779042365, name: "getez", kind: "robot", at: 0 });
      store.upsertLink({ id: "usb-relay", transport: "usb", address: { path: "/dev/cu.relay" }, at: 0 });
      store.upsertLink({ id: "radio-vevov-via-usb-relay", transport: "radio", address: { relayLinkId: "usb-relay", channel: 37, group: 43 }, deviceId: 1779042365, at: 900 });
      store.recordSighting({ deviceId: 1779042365, transport: "radio", viaLinkId: "usb-relay", at: 900, ok: true });

      const aged = store.ageRadioLinks(500, 1000); // cutoff = 500; last ok sighting was at 900
      expect(aged).toBe(0);
      expect(store.snapshotRows().links.find((l) => l.id === "radio-vevov-via-usb-relay")?.state).toBe("discovered");
    } finally {
      store.close();
    }
  });

  it("ages a radio link whose relay link no longer exists", () => {
    const { store } = freshStore();
    try {
      store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 0 });
      store.upsertLink({ id: "radio-gopiv-via-gone", transport: "radio", address: { relayLinkId: "usb-gone", channel: 1, group: 1 }, deviceId: 1198504156, at: 900 });
      const aged = store.ageRadioLinks(500, 1000);
      expect(aged).toBe(1);
      expect(store.snapshotRows().links.find((l) => l.id === "radio-gopiv-via-gone")?.state).toBe("stale");
    } finally {
      store.close();
    }
  });

  it("ages a radio link whose relay link is itself stale, regardless of the radio link's own recent sighting", () => {
    const { store } = freshStore();
    try {
      store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 0 });
      store.upsertLink({ id: "usb-relay", transport: "usb", address: { path: "/dev/cu.relay" }, at: 0 });
      store.setLinkState({ id: "usb-relay", state: "stale", at: 900 });
      store.upsertLink({ id: "radio-gopiv-via-usb-relay", transport: "radio", address: { relayLinkId: "usb-relay", channel: 47, group: 60 }, deviceId: 1198504156, at: 900 });
      store.recordSighting({ deviceId: 1198504156, transport: "radio", viaLinkId: "usb-relay", at: 900, ok: true });

      const aged = store.ageRadioLinks(500, 1000);
      expect(aged).toBe(1);
      expect(store.snapshotRows().links.find((l) => l.id === "radio-gopiv-via-usb-relay")?.state).toBe("stale");
    } finally {
      store.close();
    }
  });

  it("is idempotent -- a radio link already stale is not re-aged", () => {
    const { store } = freshStore();
    try {
      store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 0 });
      store.upsertLink({ id: "radio-gopiv-via-gone", transport: "radio", address: { relayLinkId: "usb-gone", channel: 1, group: 1 }, deviceId: 1198504156, at: 900 });
      expect(store.ageRadioLinks(500, 1000)).toBe(1);
      expect(store.ageRadioLinks(500, 2000)).toBe(0);
    } finally {
      store.close();
    }
  });

  it("never ages a radio link with an open session", () => {
    const { store } = freshStore();
    try {
      store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 0 });
      store.upsertLink({ id: "radio-gopiv-via-gone", transport: "radio", address: { relayLinkId: "usb-gone", channel: 1, group: 1 }, deviceId: 1198504156, at: 900 });
      store.openSession("radio-gopiv-via-gone", 900);
      const aged = store.ageRadioLinks(500, 1000);
      expect(aged).toBe(0);
      expect(store.snapshotRows().links.find((l) => l.id === "radio-gopiv-via-gone")?.state).toBe("discovered");
    } finally {
      store.close();
    }
  });

  it("never touches a non-radio link", () => {
    const { store } = freshStore();
    try {
      store.upsertLink({ id: "wifi-old", transport: "wifi", address: {}, at: 0 });
      const aged = store.ageRadioLinks(500, 1000);
      expect(aged).toBe(0);
      expect(store.snapshotRows().links.find((l) => l.id === "wifi-old")?.state).toBe("discovered");
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------
// ageRadioLinks connecting/grace-period exemption -- ticket 018-006
// ---------------------------------------------------------------------

describe("Store: ageRadioLinks connecting/grace-period exemption (018-006)", () => {
  it("never ages a radio link while it is connecting, even past its ttl with no sighting", () => {
    const { store } = freshStore();
    try {
      store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 0 });
      store.upsertLink({ id: "usb-relay", transport: "usb", address: { path: "/dev/cu.relay" }, at: 0 });
      store.upsertLink({
        id: "radio-gopiv-via-usb-relay",
        transport: "radio",
        address: { relayLinkId: "usb-relay", channel: 47, group: 60 },
        deviceId: 1198504156,
        at: 0,
      });
      store.setLinkState({ id: "radio-gopiv-via-usb-relay", state: "connecting", at: 0 });

      // TTL - 1: still connecting, no sighting yet -- not aged.
      expect(store.ageRadioLinks(500, 499)).toBe(0);
      expect(store.snapshotRows().links.find((l) => l.id === "radio-gopiv-via-usb-relay")?.state).toBe("connecting");

      // TTL + 1: still connecting -- exempt regardless of elapsed time.
      expect(store.ageRadioLinks(500, 501)).toBe(0);
      expect(store.snapshotRows().links.find((l) => l.id === "radio-gopiv-via-usb-relay")?.state).toBe("connecting");
    } finally {
      store.close();
    }
  });

  it("ages a radio link only after it leaves connecting (fails/idles) and a full ttl elapses since that transition, with no sighting", () => {
    const { store } = freshStore();
    try {
      store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 0 });
      store.upsertLink({ id: "usb-relay", transport: "usb", address: { path: "/dev/cu.relay" }, at: 0 });
      store.upsertLink({
        id: "radio-gopiv-via-usb-relay",
        transport: "radio",
        address: { relayLinkId: "usb-relay", channel: 47, group: 60 },
        deviceId: 1198504156,
        at: 0,
      });
      store.setLinkState({ id: "radio-gopiv-via-usb-relay", state: "connecting", at: 0 });
      // The connect attempt fails at t=501 -- state_since resets to 501.
      store.setLinkState({ id: "radio-gopiv-via-usb-relay", state: "failed", at: 501, reason: "no ID reply" });

      // Still within one ttl of the failure transition -- not yet aged.
      expect(store.ageRadioLinks(500, 501)).toBe(0);
      expect(store.snapshotRows().links.find((l) => l.id === "radio-gopiv-via-usb-relay")?.state).toBe("failed");

      // A full ttl has now elapsed since the failure transition, still no sighting.
      expect(store.ageRadioLinks(500, 1002)).toBe(1);
      expect(store.snapshotRows().links.find((l) => l.id === "radio-gopiv-via-usb-relay")?.state).toBe("stale");
    } finally {
      store.close();
    }
  });

  it("still ages immediately when the relay is gone, even for a brand-new radio link within the grace period", () => {
    // Documents that the 018-006 grace period is scoped to the
    // no-sighting-yet branch, not the relay-gone/stale branch -- a
    // relay that has provably vanished still ages its radio children
    // right away regardless of how new they are (018-005's own case).
    const { store } = freshStore();
    try {
      store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 0 });
      store.upsertLink({
        id: "radio-gopiv-via-gone",
        transport: "radio",
        address: { relayLinkId: "usb-gone", channel: 1, group: 1 },
        deviceId: 1198504156,
        at: 900,
      });
      expect(store.ageRadioLinks(500, 950)).toBe(1);
      expect(store.snapshotRows().links.find((l) => l.id === "radio-gopiv-via-gone")?.state).toBe("stale");
    } finally {
      store.close();
    }
  });
});

describe("Store: clearRadioLinkStaleText (018-005)", () => {
  it("clears state_reason on every radio link naming the given relayLinkId, leaving state untouched", () => {
    const { store } = freshStore();
    try {
      store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 0 });
      store.upsertLink({ id: "usb-relay", transport: "usb", address: { path: "/dev/cu.relayOLD" }, at: 0 });
      store.upsertLink({ id: "radio-gopiv-via-usb-relay", transport: "radio", address: { relayLinkId: "usb-relay", channel: 47, group: 60 }, deviceId: 1198504156, at: 0 });
      store.setLinkState({ id: "radio-gopiv-via-usb-relay", state: "failed", at: 100, reason: "cannot open /dev/cu.relayOLD", failCount: 3 });

      const cleared = store.clearRadioLinkStaleText("usb-relay");
      expect(cleared).toBe(1);

      const row = store.snapshotRows().links.find((l) => l.id === "radio-gopiv-via-usb-relay");
      expect(row?.state_reason).toBeNull();
      // state/fail_count are untouched -- only the text is stale here.
      expect(row?.state).toBe("failed");
      expect(row?.fail_count).toBe(3);
    } finally {
      store.close();
    }
  });

  it("is a no-op when no radio link names the given relayLinkId, or none carries failure text", () => {
    const { store } = freshStore();
    try {
      store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 0 });
      store.upsertLink({ id: "usb-relay", transport: "usb", address: { path: "/dev/cu.relay" }, at: 0 });
      store.upsertLink({ id: "radio-gopiv-via-usb-relay", transport: "radio", address: { relayLinkId: "usb-relay", channel: 47, group: 60 }, deviceId: 1198504156, at: 0 });
      expect(store.clearRadioLinkStaleText("usb-relay")).toBe(0);
      expect(store.clearRadioLinkStaleText("usb-some-other-relay")).toBe(0);
    } finally {
      store.close();
    }
  });

  it("never clears a mbrelay or other-transport link's failure text", () => {
    const { store } = freshStore();
    try {
      store.upsertLink({ id: "mbrelay-POOL", transport: "mbrelay", address: { relayLinkId: "usb-relay", channel: 1, group: 1 }, at: 0 });
      store.setLinkState({ id: "mbrelay-POOL", state: "failed", at: 100, reason: "cannot open /dev/cu.relayOLD" });
      expect(store.clearRadioLinkStaleText("usb-relay")).toBe(0);
      expect(store.snapshotRows().links.find((l) => l.id === "mbrelay-POOL")?.state_reason).toBe("cannot open /dev/cu.relayOLD");
    } finally {
      store.close();
    }
  });
});

describe("Store: upsertService", () => {
  it("upserts keyed on (instance, type), preserving first_seen and refreshing the rest", () => {
    const { store } = freshStore();
    try {
      store.upsertService({ instance: "robot1", type: "_robotconsole._tcp", host: "1.2.3.4", port: 80, txt: { a: 1 }, at: 100 });
      store.upsertService({ instance: "robot1", type: "_robotconsole._tcp", host: "1.2.3.5", port: 81, txt: { a: 2 }, at: 200 });
      const rows = store.snapshotRows().services;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ first_seen: 100, last_seen: 200, host: "1.2.3.5", port: 81 });
      expect(JSON.parse(rows[0]?.txt as string)).toEqual({ a: 2 });
    } finally {
      store.close();
    }
  });

  it("keeps distinct rows for the same instance under a different type", () => {
    const { store } = freshStore();
    try {
      store.upsertService({ instance: "robot1", type: "_typeA._tcp", at: 100 });
      store.upsertService({ instance: "robot1", type: "_typeB._tcp", at: 100 });
      expect(store.snapshotRows().services).toHaveLength(2);
    } finally {
      store.close();
    }
  });
});

describe("Store: recordSighting", () => {
  it("appends a sighting row and returns its id", () => {
    const { store, db } = freshStore();
    try {
      const id1 = store.recordSighting({ transport: "usb", at: 100, ok: true, name: "vevov" });
      const id2 = store.recordSighting({ transport: "usb", at: 200, ok: false, detail: "no banner" });
      expect(id2).toBeGreaterThan(id1);

      const rows = db.prepare("SELECT * FROM sightings ORDER BY id").all() as Array<{
        id: number;
        name: string | null;
        ok: number;
        detail: string | null;
      }>;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ id: id1, name: "vevov", ok: 1, detail: null });
      expect(rows[1]).toMatchObject({ id: id2, ok: 0, detail: "no banner" });
    } finally {
      store.close();
    }
  });
});

describe("Store: mergeDevice", () => {
  it("re-points links/sightings from the placeholder to the real row, merges owned/first_seen/radio_*, and deletes the placeholder", () => {
    const { store, db } = freshStore();
    try {
      // The bench scenario sprint 015 ticket 003's own Description cites
      // verbatim: `known-robots.json` seeded a placeholder for "vevov"
      // (nameToValue("vevov") === 1031, a synthetic id), radio-configured
      // by an earlier session; the real device later identifies as chip
      // id 536019796 (a *different* name, "vevav" -- the two disagree,
      // which is exactly why the merge cannot key on `name`).
      const PLACEHOLDER_ID = 1031;
      const REAL_ID = 536019796;
      store.upsertDevice({ id: PLACEHOLDER_ID, name: "vevov", kind: "robot", usbSerial: "0012345678", at: 100 });
      store.setOwned(PLACEHOLDER_ID, true, 100);
      db.prepare("UPDATE devices SET radio_channel = ?, radio_group = ?, radio_source = ? WHERE id = ?").run(
        5,
        2,
        "registry",
        PLACEHOLDER_ID,
      );
      store.upsertLink({ id: "radio-vevov", transport: "radio", address: { relayLinkId: "usb-relay", channel: 5, group: 2 }, deviceId: PLACEHOLDER_ID, at: 100 });
      const sightingId = store.recordSighting({ deviceId: PLACEHOLDER_ID, transport: "radio", at: 100, ok: true });

      store.upsertDevice({ id: REAL_ID, name: "vevav", kind: "robot", at: 500 });
      store.mergeDevice(PLACEHOLDER_ID, REAL_ID, 500);

      const rows = store.snapshotRows();
      expect(rows.devices).toHaveLength(1);
      expect(rows.devices[0]).toMatchObject({
        id: REAL_ID,
        name: "vevav",
        owned: 1,
        first_seen: 100,
        radio_channel: 5,
        radio_group: 2,
        radio_source: "registry",
      });

      expect(rows.links).toHaveLength(1);
      expect(rows.links[0]).toMatchObject({ id: "radio-vevov", device_id: REAL_ID });

      const sightingRows = db.prepare("SELECT id, device_id FROM sightings").all() as Array<{
        id: number;
        device_id: number | null;
      }>;
      expect(sightingRows).toEqual([{ id: sightingId, device_id: REAL_ID }]);
    } finally {
      store.close();
    }
  });

  it("never clobbers the real row's own already-set radio_* fields with the placeholder's", () => {
    const { store } = freshStore();
    try {
      store.upsertDevice({ id: 1031, name: "vevov", kind: "robot", at: 100 });
      store.upsertDevice({ id: 536019796, name: "vevav", kind: "robot", radioChannel: 9, radioGroup: 1, radioSource: "override", at: 200 });
      store.mergeDevice(1031, 536019796, 200);
      const row = store.snapshotRows().devices[0];
      expect(row).toMatchObject({ radio_channel: 9, radio_group: 1, radio_source: "override" });
    } finally {
      store.close();
    }
  });

  it("carries usb_serial from the placeholder when the real row has none, but never clobbers a usb_serial the real row already has (bench defect 2)", () => {
    const { store } = freshStore();
    try {
      // First pairing: the real row has no usb_serial of its own yet --
      // the placeholder's own (a known-robots.json import's own
      // "last seen via USB" hint, per connector.ts's own doc comment)
      // survives the merge instead of being dropped.
      store.upsertDevice({ id: 1031, name: "vevov", kind: "robot", usbSerial: "0012345678", at: 100 });
      store.upsertDevice({ id: 536019796, name: "vevav", kind: "robot", at: 200 });
      store.mergeDevice(1031, 536019796, 200);
      expect(store.snapshotRows().devices[0]).toMatchObject({ id: 536019796, usb_serial: "0012345678" });
    } finally {
      store.close();
    }
  });

  it("never clobbers the real row's own already-set usb_serial with the placeholder's", () => {
    const { store } = freshStore();
    try {
      store.upsertDevice({ id: 1031, name: "vevov", kind: "robot", usbSerial: "old-serial", at: 100 });
      store.upsertDevice({ id: 536019796, name: "vevav", kind: "robot", usbSerial: "real-serial", at: 200 });
      store.mergeDevice(1031, 536019796, 200);
      expect(store.snapshotRows().devices[0]).toMatchObject({ id: 536019796, usb_serial: "real-serial" });
    } finally {
      store.close();
    }
  });

  it("is a no-op (rolls back, changes nothing) when either id has no devices row, or the ids are equal", () => {
    const { store } = freshStore();
    try {
      store.upsertDevice({ id: 536019796, name: "vevav", kind: "robot", at: 100 });
      store.mergeDevice(1031, 536019796, 200); // 1031 has no row
      expect(store.snapshotRows().devices).toHaveLength(1);

      store.mergeDevice(536019796, 536019796, 200); // same id
      expect(store.snapshotRows().devices).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});

describe("Store: deleteDevice", () => {
  it("deletes the devices row and its links (stakeholder 2026-09-13: a forgotten board must not linger as an unidentified card); sightings are re-pointed to NULL", () => {
    const { store, db } = freshStore();
    try {
      const ID = 536019796;
      store.upsertDevice({ id: ID, name: "vevav", kind: "robot", at: 100 });
      store.upsertLink({ id: "usb-vevav", transport: "usb", address: { path: "/dev/cu.vevav" }, deviceId: ID, at: 100 });
      store.upsertLink({ id: "usb-other", transport: "usb", address: { path: "/dev/cu.other" }, at: 100 });
      const sightingId = store.recordSighting({ deviceId: ID, transport: "usb", at: 100, ok: true });

      store.deleteDevice(ID);

      const rows = store.snapshotRows();
      expect(rows.devices).toHaveLength(0);
      expect(rows.links.map((link) => link.id)).toEqual(["usb-other"]);
      const sightingRow = db.prepare("SELECT device_id FROM sightings WHERE id = ?").get(sightingId);
      expect(sightingRow).toMatchObject({ device_id: null });
    } finally {
      store.close();
    }
  });

  it("is a no-op for an id with no devices row", () => {
    const { store } = freshStore();
    try {
      store.deleteDevice(1234);
      expect(store.snapshotRows().devices).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});

describe("Store: deleteLink (018-010)", () => {
  it("deletes the links row outright -- unlike deleteDevice, no row survives", () => {
    const { store } = freshStore();
    try {
      store.upsertLink({ id: "mbrelay-gala", transport: "mbrelay", address: { host: "gala.local", port: 8760 }, at: 100 });
      store.deleteLink("mbrelay-gala");
      expect(store.snapshotRows().links).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("first deletes any sessions/relay_leases row for the link, since both carry a REFERENCES links(id) foreign key", () => {
    const { store, db } = freshStore();
    try {
      store.upsertLink({ id: "mbrelay-gala", transport: "mbrelay", address: { host: "gala.local", port: 8760 }, at: 100 });
      store.openSession("mbrelay-gala", 100);
      store.acquireRelayLease("mbrelay-gala", "sweep", 100);

      expect(() => store.deleteLink("mbrelay-gala")).not.toThrow();

      expect(store.snapshotRows().links).toHaveLength(0);
      expect(db.prepare("SELECT * FROM sessions WHERE link_id = ?").get("mbrelay-gala")).toBeUndefined();
      expect(db.prepare("SELECT * FROM relay_leases WHERE relay_link_id = ?").get("mbrelay-gala")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("is a no-op for an id with no links row", () => {
    const { store } = freshStore();
    try {
      expect(() => store.deleteLink("no-such-link")).not.toThrow();
      expect(store.snapshotRows().links).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});

describe("Store: sessions", () => {
  it("opens, updates, and closes a session", () => {
    const { store } = freshStore();
    try {
      store.upsertLink({ id: "link-1", transport: "usb", address: {}, at: 1 });
      store.openSession("link-1", 100);
      let row = store.snapshotRows().sessions[0];
      expect(row).toMatchObject({ link_id: "link-1", opened_at: 100, seq: null });

      store.updateSession("link-1", { seq: 5, pending: 1, robotStatus: "idle", functions: { rgbled: true } });
      row = store.snapshotRows().sessions[0];
      expect(row).toMatchObject({ seq: 5, pending: 1, robot_status: "idle" });
      expect(JSON.parse(row?.functions as string)).toEqual({ rgbled: true });

      // partial update omitting seq must not clear it
      store.updateSession("link-1", { lastDone: 7, lastDoneReason: "ok" });
      row = store.snapshotRows().sessions[0];
      expect(row).toMatchObject({ seq: 5, last_done: 7, last_done_reason: "ok" });

      store.closeSession("link-1");
      expect(store.snapshotRows().sessions).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("re-opening a session clears its prior transient fields", () => {
    const { store } = freshStore();
    try {
      store.upsertLink({ id: "link-1", transport: "usb", address: {}, at: 1 });
      store.openSession("link-1", 100);
      store.updateSession("link-1", { seq: 9 });
      store.openSession("link-1", 200);
      const row = store.snapshotRows().sessions[0];
      expect(row).toMatchObject({ opened_at: 200, seq: null });
    } finally {
      store.close();
    }
  });

  // Sprint 018 ticket 010 (SUC-007): `answered_at` -- the UI's "Linked"
  // criterion reads this via `projectionRows().sessions[].answeredAt`
  // (see `deviceDisplay.ts`'s `isLinkAnswering`).
  it("answered_at is null until updateSession sets it, and survives an omitted patch", () => {
    const { store } = freshStore();
    try {
      store.upsertLink({ id: "link-1", transport: "usb", address: {}, at: 1 });
      store.openSession("link-1", 100);
      let row = store.snapshotRows().sessions[0];
      expect(row).toMatchObject({ answered_at: null });

      store.updateSession("link-1", { answeredAt: 150 });
      row = store.snapshotRows().sessions[0];
      expect(row).toMatchObject({ answered_at: 150 });

      // A later patch that omits answeredAt (e.g. a functions-only
      // write) must not clear it -- COALESCE, same discipline as every
      // other session field.
      store.updateSession("link-1", { functions: [{ name: "drive" }] });
      row = store.snapshotRows().sessions[0];
      expect(row).toMatchObject({ answered_at: 150 });
    } finally {
      store.close();
    }
  });

  it("re-opening a session clears answered_at along with every other transient field", () => {
    const { store } = freshStore();
    try {
      store.upsertLink({ id: "link-1", transport: "usb", address: {}, at: 1 });
      store.openSession("link-1", 100);
      store.updateSession("link-1", { answeredAt: 150 });
      store.openSession("link-1", 200);
      const row = store.snapshotRows().sessions[0];
      expect(row).toMatchObject({ opened_at: 200, answered_at: null });
    } finally {
      store.close();
    }
  });
});

describe("Store: board ownership", () => {
  it("acquires exclusively, is idempotent for the same owner, and refuses a different owner", () => {
    const { store, db } = freshStore();
    try {
      expect(store.acquireBoardOwner("serial-1", "naming", 100)).toBe(true);
      expect(store.acquireBoardOwner("serial-1", "naming", 150)).toBe(true); // same owner: refresh
      expect(store.acquireBoardOwner("serial-1", "flash", 200)).toBe(false); // different owner: refused

      const row = db.prepare("SELECT owner, since FROM board_owner WHERE usb_serial = ?").get("serial-1") as
        | { owner: string; since: number }
        | undefined;
      expect(row).toEqual({ owner: "naming", since: 150 });

      expect(store.releaseBoardOwner("serial-1", "flash")).toBe(false); // not the owner
      expect(store.releaseBoardOwner("serial-1", "naming")).toBe(true);
      expect(store.releaseBoardOwner("serial-1", "naming")).toBe(false); // already released
      expect(db.prepare("SELECT * FROM board_owner WHERE usb_serial = ?").get("serial-1")).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

describe("Store: relay leases", () => {
  it("acquires exclusively, is idempotent for the same owner, and refuses a different owner", () => {
    const { store, db } = freshStore();
    try {
      store.upsertLink({ id: "relay-link-1", transport: "radio", address: {}, at: 1 });
      expect(store.acquireRelayLease("relay-link-1", "sweep", 100)).toBe(true);
      expect(store.acquireRelayLease("relay-link-1", "sweep", 150)).toBe(true);
      expect(store.acquireRelayLease("relay-link-1", "session:child-1", 200)).toBe(false);

      const row = db.prepare("SELECT owner FROM relay_leases WHERE relay_link_id = ?").get("relay-link-1") as
        | { owner: string }
        | undefined;
      expect(row?.owner).toBe("sweep");

      expect(store.releaseRelayLease("relay-link-1", "session:child-1")).toBe(false);
      expect(store.releaseRelayLease("relay-link-1", "sweep")).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("Store: firmware / settings / heartbeat", () => {
  it("setFirmware upserts by kind", () => {
    const { store, db } = freshStore();
    try {
      store.setFirmware({ kind: "robot", repo: "org/repo", tag: "v1", available: true, checkedAt: 100 });
      store.setFirmware({ kind: "robot", repo: "org/repo", tag: "v2", available: false, checkedAt: 200 });
      const row = db.prepare("SELECT * FROM firmware WHERE kind = 'robot'").get() as Record<string, unknown>;
      expect(row).toMatchObject({ tag: "v2", available: 0, checked_at: 200 });
    } finally {
      store.close();
    }
  });

  it("getFirmwareEtag reads the stored etag, undefined when never polled or absent", () => {
    const { store } = freshStore();
    try {
      expect(store.getFirmwareEtag("robot")).toBeUndefined();
      store.setFirmware({ kind: "robot", repo: "org/repo", tag: "v1", available: true, etag: '"abc123"', checkedAt: 100 });
      expect(store.getFirmwareEtag("robot")).toBe('"abc123"');
      expect(store.getFirmwareEtag("relay")).toBeUndefined();
      store.setFirmware({ kind: "robot", repo: "org/repo", tag: "v2", available: true, checkedAt: 200 });
      expect(store.getFirmwareEtag("robot")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("getSetting/setSetting round-trip and upsert", () => {
    const { store } = freshStore();
    try {
      expect(store.getSetting("wifiCredentials")).toBeUndefined();
      store.setSetting("wifiCredentials", JSON.stringify({ ssid: "a" }));
      expect(store.getSetting("wifiCredentials")).toBe(JSON.stringify({ ssid: "a" }));
      store.setSetting("wifiCredentials", JSON.stringify({ ssid: "b" }));
      expect(store.getSetting("wifiCredentials")).toBe(JSON.stringify({ ssid: "b" }));
    } finally {
      store.close();
    }
  });

  it("heartbeat upserts a running task row with a fresh timestamp", () => {
    const { store } = freshStore();
    try {
      store.heartbeat("usbWatcher", 100);
      let row = store.snapshotRows().tasks[0];
      expect(row).toMatchObject({ name: "usbWatcher", state: "running", heartbeat_at: 100 });
      store.heartbeat("usbWatcher", 200, "scanning");
      row = store.snapshotRows().tasks[0];
      expect(row).toMatchObject({ heartbeat_at: 200, detail: "scanning" });
    } finally {
      store.close();
    }
  });
});

describe("Store: snapshotRows", () => {
  it("returns rows from devices/links/services/sessions/tasks", () => {
    const { store } = freshStore();
    try {
      store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 1 });
      store.upsertLink({ id: "link-1", transport: "usb", address: {}, at: 1 });
      store.upsertService({ instance: "i", type: "t", at: 1 });
      store.openSession("link-1", 1);
      store.heartbeat("task-1", 1);
      const snapshot = store.snapshotRows();
      expect(snapshot.devices).toHaveLength(1);
      expect(snapshot.links).toHaveLength(1);
      expect(snapshot.services).toHaveLength(1);
      expect(snapshot.sessions).toHaveLength(1);
      expect(snapshot.tasks).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});

describe("Store: reconcilerRows", () => {
  it("returns typed, camelCased devices/links/sessions/relayLeases", () => {
    const { store } = freshStore();
    try {
      store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 1 });
      store.setOwned(1198504156, true, 2);
      store.upsertLink({ id: "link-1", transport: "wifi", address: { host: "10.0.0.5", port: 4000 }, deviceId: 1198504156, at: 3 });
      store.setLinkState({ id: "link-1", state: "failed", at: 4, reason: "boom", failCount: 2, nextRetryAt: 100 });
      store.openSession("link-1", 5);
      store.upsertLink({ id: "relay-1", transport: "usb", address: { path: "/dev/relay" }, at: 5 });
      store.acquireRelayLease("relay-1", "session:radio-child", 6);

      const rows = store.reconcilerRows();

      expect(rows.devices).toEqual([{ id: 1198504156, kind: "robot", owned: true }]);
      expect(rows.links.find((l) => l.id === "link-1")).toEqual({
        id: "link-1",
        deviceId: 1198504156,
        transport: "wifi",
        address: { host: "10.0.0.5", port: 4000 },
        state: "failed",
        nextRetryAt: 100,
        failCount: 2,
        userClosed: false,
      });
      expect(rows.sessions).toEqual([{ linkId: "link-1" }]);
      expect(rows.relayLeases).toEqual([{ relayLinkId: "relay-1", owner: "session:radio-child" }]);
    } finally {
      store.close();
    }
  });

  it("reports userClosed and a null deviceId/nextRetryAt as their own values, not coerced", () => {
    const { store } = freshStore();
    try {
      store.upsertLink({ id: "link-2", transport: "usb", address: { path: "/dev/x" }, at: 1 });
      store.setLinkState({ id: "link-2", state: "closed_by_user", at: 2, userClosed: true });

      const rows = store.reconcilerRows();
      expect(rows.links).toEqual([
        {
          id: "link-2",
          deviceId: null,
          transport: "usb",
          address: { path: "/dev/x" },
          state: "closed_by_user",
          nextRetryAt: null,
          failCount: 0,
          userClosed: true,
        },
      ]);
    } finally {
      store.close();
    }
  });
});

describe("Store: projectionRows", () => {
  it("returns typed, camelCased devices/links/sessions/relayLeases/firmware/tasks", () => {
    const { store } = freshStore();
    try {
      store.upsertDevice({
        id: 1198504156,
        name: "vevov",
        kind: "robot",
        role: "NEZHA2",
        commonName: "robot",
        radioChannel: 41,
        radioGroup: 3,
        radioSource: "override",
        at: 1,
      });
      store.setOwned(1198504156, true, 2);
      store.upsertLink({
        id: "link-1",
        transport: "wifi",
        address: { host: "10.0.0.5", port: 4000 },
        deviceId: 1198504156,
        at: 3,
      });
      store.setLinkState({ id: "link-1", state: "connected", at: 4 });
      store.openSession("link-1", 5);
      store.updateSession("link-1", {
        seq: 3,
        pending: 1,
        lastDone: 2,
        lastDoneReason: "ok",
        robotStatus: JSON.stringify({
          receivedAt: 5,
          fields: { flags: "1" },
          ready: true,
          active: true,
          estopped: false,
          stallHalted: false,
          leaseExpired: false,
        }),
        functions: [{ name: "drive" }],
      });
      store.upsertLink({ id: "relay-1", transport: "usb", address: { path: "/dev/relay" }, at: 5 });
      store.acquireRelayLease("relay-1", "sweep", 6);
      store.setFirmware({ kind: "robot", repo: "org/repo", tag: "v1", available: true, checkedAt: 7 });
      store.heartbeat("usbWatcher", 8, "polling");
      store.recordSighting({ deviceId: 1198504156, transport: "wifi", at: 9, ok: true });
      store.recordSighting({ deviceId: 1198504156, transport: "wifi", at: 11, ok: true });

      const rows = store.projectionRows();

      expect(rows.devices).toEqual([
        {
          id: 1198504156,
          name: "vevov",
          kind: "robot",
          role: "NEZHA2",
          commonName: "robot",
          program: null,
          version: null,
          usbSerial: null,
          radioChannel: 41,
          radioGroup: 3,
          radioSource: "override",
          owned: true,
          lastSeen: 2,
        },
      ]);

      const link1 = rows.links.find((l) => l.id === "link-1");
      expect(link1).toEqual({
        id: "link-1",
        deviceId: 1198504156,
        transport: "wifi",
        address: { host: "10.0.0.5", port: 4000 },
        state: "connected",
        stateReason: null,
        stateSince: 4,
        lastSeen: 3,
        nextRetryAt: null,
        failCount: 0,
        userClosed: false,
      });

      expect(rows.sessions).toEqual([
        {
          linkId: "link-1",
          seq: 3,
          pending: 1,
          lastDone: 2,
          lastDoneReason: "ok",
          robotStatus: {
            receivedAt: 5,
            fields: { flags: "1" },
            ready: true,
            active: true,
            estopped: false,
            stallHalted: false,
            leaseExpired: false,
          },
          functions: [{ name: "drive" }],
          answeredAt: null,
        },
      ]);

      expect(rows.relayLeases).toEqual([{ relayLinkId: "relay-1", owner: "sweep" }]);
      expect(rows.firmware).toEqual([
        { kind: "robot", repo: "org/repo", tag: "v1", available: true, reason: null, message: null },
      ]);
      expect(rows.tasks).toEqual([{ name: "usbWatcher", state: "running", heartbeatAt: 8 }]);
      expect(rows.lastChecked).toEqual([{ deviceId: 1198504156, at: 11 }]);
      expect(rows.wifiCredentials).toBeNull();
      expect(rows.fastSweepByRelayLinkId).toEqual(new Map());
    } finally {
      store.close();
    }
  });

  it("reports each relay's fast-sweep capability flag, keyed by relayLinkId (ticket 016-007)", () => {
    const { store } = freshStore();
    try {
      store.setSetting("relaySweepFast:relay-1", "1");
      store.setSetting("relaySweepFast:relay-2", "0");

      const rows = store.projectionRows();
      expect(rows.fastSweepByRelayLinkId).toEqual(
        new Map([
          ["relay-1", true],
          ["relay-2", false],
        ]),
      );
    } finally {
      store.close();
    }
  });

  it("reports an absent session's robotStatus/functions as null, not undefined or a string", () => {
    const { store } = freshStore();
    try {
      store.upsertLink({ id: "link-1", transport: "usb", address: { path: "/dev/x" }, at: 1 });
      store.openSession("link-1", 2);

      const rows = store.projectionRows();
      expect(rows.sessions).toEqual([
        { linkId: "link-1", seq: null, pending: null, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null, answeredAt: null },
      ]);
    } finally {
      store.close();
    }
  });

  it("parses a stored wifiCredentials setting into ssid/password", () => {
    const { store } = freshStore();
    try {
      store.setSetting("wifiCredentials", JSON.stringify({ ssid: "classroom", password: "secret" }));
      const rows = store.projectionRows();
      expect(rows.wifiCredentials).toEqual({ ssid: "classroom", password: "secret" });
    } finally {
      store.close();
    }
  });

  it("reports no wifiCredentials as null rather than throwing", () => {
    const { store } = freshStore();
    try {
      const rows = store.projectionRows();
      expect(rows.wifiCredentials).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("Store: change feed", () => {
  it("emits exactly one coalesced event per transaction burst", async () => {
    const { store } = freshStore();
    try {
      const received: (readonly ChangeEvent[])[] = [];
      store.onChange((changes) => received.push(changes));

      // several writes performed synchronously, in one macrotask
      store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 1 });
      store.setOwned(1198504156, true, 2);
      store.upsertLink({ id: "link-1", transport: "usb", address: {}, at: 3 });

      expect(received).toHaveLength(0); // not yet flushed

      await nextMacrotask();

      expect(received).toHaveLength(1);
      expect(received[0]).toHaveLength(3);
      expect(received[0]?.map((c) => c.tbl)).toEqual(["devices", "devices", "links"]);
      // seq strictly increasing
      const seqs = received[0]?.map((c) => c.seq) ?? [];
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    } finally {
      store.close();
    }
  });

  it("emits a second, separate event for writes in a later macrotask", async () => {
    const { store } = freshStore();
    try {
      const received: (readonly ChangeEvent[])[] = [];
      store.onChange((changes) => received.push(changes));

      store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 1 });
      await nextMacrotask();
      store.setOwned(1198504156, true, 2);
      await nextMacrotask();

      expect(received).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("never emits for a write that throws (name/serial mismatch)", async () => {
    const { store } = freshStore();
    try {
      const received: unknown[] = [];
      store.onChange((changes) => received.push(changes));

      expect(() => store.upsertDevice({ id: 1779042496, name: "getez", kind: "relay", at: 1 })).toThrow();
      await nextMacrotask();

      expect(received).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("never emits for an acquire that is refused (no actual change)", async () => {
    const { store } = freshStore();
    try {
      store.acquireBoardOwner("serial-1", "naming", 100);
      await nextMacrotask(); // flush the successful acquire before subscribing

      const received: unknown[] = [];
      store.onChange((changes) => received.push(changes));

      expect(store.acquireBoardOwner("serial-1", "flash", 200)).toBe(false);
      await nextMacrotask();

      expect(received).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("onChange's returned unsubscribe function stops delivery", async () => {
    const { store } = freshStore();
    try {
      const received: unknown[] = [];
      const unsubscribe = store.onChange((changes) => received.push(changes));
      unsubscribe();

      store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 1 });
      await nextMacrotask();

      expect(received).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});
