import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openStoreDb } from "./db.js";
import { DeviceNameMismatchError, Store, type ChangeEvent } from "./index.js";

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
