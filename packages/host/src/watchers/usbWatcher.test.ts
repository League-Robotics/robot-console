import { describe, expect, it, vi } from "vitest";
import { openStoreDb } from "../store/db.js";
import { Store } from "../store/index.js";
import type { DaplinkDevice } from "../devices.js";
import type { SwdNameResult } from "../swdName.js";
import { startUsbWatcher, type UsbWatcherDeps, type UsbWatcherOptions } from "./usbWatcher.js";

// Ticket 014-007's own suite, rewritten by sprint 015 ticket 003:
// `usbWatcher.ts` no longer opens a `LineLink` or runs a `HELLO`
// identify itself (that moved to `connect/connector.ts`, scheduled by
// `connect/reconciler.ts` -- see `usbWatcher.ts`'s own module doc
// comment). This suite therefore only exercises the SWD-naming
// attach/updated/removed/heartbeat flow and asserts a named board ends
// up `connectable` (the reconciler's own seam), never `connected` --
// `connect/connector.test.ts` and `connect/reconciler.test.ts` cover
// everything past that point. No real serialport/node-hid/SWD I/O
// anywhere here -- every seam (enumerator, SWD namer, clock) is
// injected, per the ticket's own testing note.

/** A fresh in-memory, fully-migrated store for one test. */
function freshStore(): Store {
  return new Store(openStoreDb({ filePath: ":memory:" }));
}

/** Whether nothing (`'naming'` included) currently holds `usbSerial`'s
 * `board_owner` row -- probed through {@link Store.acquireBoardOwner}'s
 * own typed contract (a claim under a throwaway owner name succeeds iff
 * no other owner holds it, and is released immediately after) rather
 * than a raw SQL read: `board_owner` is deliberately not one of
 * `Store.snapshotRows()`'s exposed tables, and this file lives outside
 * `store/`, where the "no SQL outside store/" rule
 * (`noRawSqlOutsideStore.test.ts`) forbids a direct raw-SQL statement. */
function boardOwnerIsFree(store: Store, usbSerial: string): boolean {
  const acquired = store.acquireBoardOwner(usbSerial, "test-probe", Date.now());
  if (acquired) {
    store.releaseBoardOwner(usbSerial, "test-probe");
  }
  return acquired;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor: timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const SERIAL_A = "9900000031864e451111111111111111000000000000001";
const VEVOV_ID = 1198504156;

function serialOnlyDevice(serialNumber: string, path: string): DaplinkDevice {
  return {
    serialNumber,
    displaySerial: serialNumber.slice(-8),
    availability: "serial-only",
    serialPort: { path },
  };
}

function fullDevice(serialNumber: string, path: string, hidPath: string): DaplinkDevice {
  return {
    serialNumber,
    displaySerial: serialNumber.slice(-8),
    availability: "full",
    serialPort: { path },
    hid: { path: hidPath },
  };
}

function hidOnlyDevice(serialNumber: string, hidPath: string): DaplinkDevice {
  return {
    serialNumber,
    displaySerial: serialNumber.slice(-8),
    availability: "hid-only",
    hid: { path: hidPath },
  };
}

const NAMED_VEVOV: SwdNameResult = { status: "named", name: "vevov", deviceId: VEVOV_ID };
const NEVER_NAMED: SwdNameResult = { status: "unnamed", reason: "no-hid-path", error: "no HID path" };

describe("startUsbWatcher", () => {
  it("added + SWD naming success yields one devices row and a connectable links row (no connect of its own)", async () => {
    const store = freshStore();
    const listDevices = vi.fn(async () => [serialOnlyDevice(SERIAL_A, "/dev/cu.usbmodemA")]);
    const deps: UsbWatcherDeps = { listDevices, readSwdName: async () => NAMED_VEVOV };
    const handle = startUsbWatcher(store, deps, { pollIntervalMs: 10 });
    try {
      await waitFor(() => store.snapshotRows().links[0]?.state === "connectable");

      const rows = store.snapshotRows();
      expect(rows.devices).toHaveLength(1);
      expect(rows.devices[0]).toMatchObject({ id: VEVOV_ID, name: "vevov", kind: "robot" });
      expect(rows.links).toHaveLength(1);
      expect(rows.links[0]).toMatchObject({ id: `usb-${SERIAL_A}`, device_id: VEVOV_ID, state: "connectable" });
      expect(rows.sessions).toHaveLength(0);
      expect(boardOwnerIsFree(store, SERIAL_A)).toBe(true);
    } finally {
      handle.stop();
      store.close();
    }
  });

  it("SWD naming failure leaves the link discovered, not connectable -- nothing for the reconciler to schedule yet", async () => {
    const store = freshStore();
    const listDevices = vi.fn(async () => [serialOnlyDevice(SERIAL_A, "/dev/cu.usbmodemA")]);
    const deps: UsbWatcherDeps = { listDevices, readSwdName: async () => NEVER_NAMED };
    const handle = startUsbWatcher(store, deps, { pollIntervalMs: 10 });
    try {
      await waitFor(() => store.snapshotRows().links.length > 0);
      // Give a couple more polls a chance to (wrongly) promote the link.
      await new Promise((resolve) => setTimeout(resolve, 30));

      const rows = store.snapshotRows();
      expect(rows.devices).toHaveLength(0);
      expect(rows.links[0]).toMatchObject({ device_id: null, state: "discovered" });
      expect(boardOwnerIsFree(store, SERIAL_A)).toBe(true);
    } finally {
      handle.stop();
      store.close();
    }
  });

  it("a HID-only attach (no serial port yet) never becomes connectable, even once named", async () => {
    const store = freshStore();
    const listDevices = vi.fn(async () => [hidOnlyDevice(SERIAL_A, "IOHIDDevice@A")]);
    const deps: UsbWatcherDeps = { listDevices, readSwdName: async () => NAMED_VEVOV };
    const handle = startUsbWatcher(store, deps, { pollIntervalMs: 10 });
    try {
      await waitFor(() => store.snapshotRows().devices.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 30));

      const rows = store.snapshotRows();
      expect(rows.devices[0]).toMatchObject({ id: VEVOV_ID });
      expect(rows.links[0]).toMatchObject({ device_id: VEVOV_ID, state: "discovered" });
    } finally {
      handle.stop();
      store.close();
    }
  });

  it("an update (serial then HID one poll apart) never re-runs SWD naming and leaves the row's state untouched", async () => {
    const store = freshStore();
    const readSwdName = vi.fn(async () => NEVER_NAMED);

    let poll = 0;
    const listDevices = vi.fn(async () => {
      poll++;
      return poll === 1
        ? [serialOnlyDevice(SERIAL_A, "/dev/cu.usbmodemA")]
        : [fullDevice(SERIAL_A, "/dev/cu.usbmodemA", "IOHIDDevice@A")];
    });

    const deps: UsbWatcherDeps = { listDevices, readSwdName };
    const handle = startUsbWatcher(store, deps, { pollIntervalMs: 10 });
    try {
      await waitFor(() => store.snapshotRows().links.length > 0);
      // Let the `updated` poll happen too.
      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(readSwdName).toHaveBeenCalledTimes(1);
      const rows = store.snapshotRows();
      expect(rows.links).toHaveLength(1);
      expect(rows.links[0]).toMatchObject({ state: "discovered" });
      expect(JSON.parse(rows.links[0]?.address as string)).toMatchObject({ hidPath: "IOHIDDevice@A" });
    } finally {
      handle.stop();
      store.close();
    }
  });

  it("removed ages the link to stale within one poll, aborts any in-flight attach, and releases any board_owner row", async () => {
    const store = freshStore();
    let poll = 0;
    const listDevices = vi.fn(async () => {
      poll++;
      return poll === 1 ? [serialOnlyDevice(SERIAL_A, "/dev/cu.usbmodemA")] : [];
    });
    const deps: UsbWatcherDeps = { listDevices, readSwdName: async () => NAMED_VEVOV };
    const handle = startUsbWatcher(store, deps, { pollIntervalMs: 10 });
    try {
      await waitFor(() => store.snapshotRows().links[0]?.state === "connectable");
      expect(boardOwnerIsFree(store, SERIAL_A)).toBe(true);

      // The next poll (poll >= 2) reports the board gone.
      await waitFor(() => store.snapshotRows().links[0]?.state === "stale");

      expect(boardOwnerIsFree(store, SERIAL_A)).toBe(true);
    } finally {
      handle.stop();
      store.close();
    }
  });

  it("a removal racing an in-flight SWD read (before any links row exists yet) skips marking the link connectable", async () => {
    const store = freshStore();
    let resolveSwd: ((result: SwdNameResult) => void) | undefined;
    const readSwdName = vi.fn(
      () =>
        new Promise<SwdNameResult>((resolve) => {
          resolveSwd = resolve;
        }),
    );

    let poll = 0;
    const listDevices = vi.fn(async () => {
      poll++;
      return poll === 1 ? [serialOnlyDevice(SERIAL_A, "/dev/cu.usbmodemA")] : [];
    });
    const deps: UsbWatcherDeps = { listDevices, readSwdName };
    const handle = startUsbWatcher(store, deps, { pollIntervalMs: 10 });
    try {
      await waitFor(() => readSwdName.mock.calls.length > 0);
      // Board removed while SWD naming is still pending.
      await waitFor(() => poll >= 2);
      resolveSwd?.(NAMED_VEVOV);
      // Give the (now-aborted) attach a chance to finish naming and
      // decide whether to mark the link connectable.
      await new Promise((resolve) => setTimeout(resolve, 30));

      const rows = store.snapshotRows();
      // `handleRemoved`'s own `setLinkState('stale')` ran before the
      // link's row even existed (the racing attach had not reached its
      // `upsertLink` call yet -- it was still awaiting the pending SWD
      // read), so it was a no-op; the row `upsertLink` creates once SWD
      // naming resolves starts fresh at `discovered` (its own insert
      // default) -- the important thing this test guards is that the
      // now-aborted attach never promotes it past that to `connectable`.
      expect(rows.links[0]).toMatchObject({ state: "discovered" });
    } finally {
      handle.stop();
      store.close();
    }
  });

  it("heartbeats a tasks row on every poll", async () => {
    const store = freshStore();
    const listDevices = vi.fn(async () => []);
    const deps: UsbWatcherDeps = { listDevices };
    const handle = startUsbWatcher(store, deps, { pollIntervalMs: 10 });
    try {
      await waitFor(() => store.snapshotRows().tasks.length > 0);
      const task = store.snapshotRows().tasks.find((row) => row.name === "usbWatcher");
      expect(task).toMatchObject({ name: "usbWatcher", state: "running" });
    } finally {
      handle.stop();
      store.close();
    }
  });
});
