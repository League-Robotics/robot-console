import { describe, expect, it } from "vitest";
import { nameToValue } from "@robot-console/protocol";
import { openStoreDb } from "../store/db.js";
import { Store } from "../store/index.js";
import type { MbregistryClient, RegistryDevice, ResolvedEndpoint, WatchEvent } from "../mbregistry/client.js";
import { startMbregistryWatcher, type MbregistryWatcherDeps } from "./mbregistryWatcher.js";

// Sprint 018 ticket 002's own suite: no real mbregistry process or
// JSON-lines socket anywhere here (sprint.md's Test Strategy) — every
// `list()`/`watch()` call is driven by a hand-rolled fake matching
// `MbregistryClient`'s own interface (ticket 001), scripted directly.
// Assertions read store rows only, never watch/list plumbing directly,
// matching every other watcher's own test convention
// (architecture.md §11).

/** A fresh in-memory, fully-migrated store for one test. */
function freshStore(): Store {
  return new Store(openStoreDb({ filePath: ":memory:" }));
}

const ENDPOINT: ResolvedEndpoint = { kind: "unix", path: "/tmp/mbregistry-test/api.sock" };

/** Every `RegistryDevice` field {@link MbregistryClient.list} declares,
 * defaulted to an "unprobed, nothing known yet" shape — tests override
 * only the fields they care about. */
function registryDevice(overrides: Partial<RegistryDevice>): RegistryDevice {
  return {
    uid: "usb:0001",
    short_uid: "0001",
    port: "/dev/ttyACM0",
    vid_pid: "0d28:0204",
    role: null,
    common_name: null,
    device_name: null,
    serial_payload: null,
    raw_announcement: null,
    state: "attached_unprobed",
    error_note: null,
    flash_count: 0,
    chip_identity_name: null,
    chip_identity_serial: null,
    first_seen: 0,
    last_seen: 0,
    last_probe: null,
    lock_kind: null,
    lock_pid: null,
    lock_label: null,
    lock_since: null,
    host: null,
    endpoint: null,
    ...overrides,
  };
}

/** VEVOV: the same `name`/chip-id fixture pair `usbWatcher.test.ts` uses
 * for its own SWD-naming success case (`deviceIdToName(1198504156) ===
 * "vevov"`, NEZHA2/decimal radix) — deliberately *not*
 * `nameToValue("vevov")` (1031), which lands in the small id range
 * `store/importers/knownRobots.ts` placeholders use, so a real
 * mbregistry-identified id and a placeholder id stay obviously distinct
 * in these fixtures, matching the merge test's own setup below. */
const VEVOV_NAME = "vevov";
const VEVOV_ID = 1198504156;

function vevovDevice(overrides: Partial<RegistryDevice> = {}): RegistryDevice {
  return registryDevice({
    uid: "usb:vevov",
    role: "NEZHA2",
    common_name: "robot",
    device_name: VEVOV_NAME,
    serial_payload: String(VEVOV_ID),
    raw_announcement: `device NEZHA2 robot ${VEVOV_NAME} ${VEVOV_ID}`,
    state: "connected",
    ...overrides,
  });
}

/** A controllable fake `MbregistryClient`: `list()` returns whatever is
 * queued, and `watch()` is an async generator fed by {@link emit} —
 * mirrors `client.ts`'s own real `JsonLinesConnection.watch()` queue/
 * waiter shape closely enough that a test can push one event at a time
 * and `await` its effect deterministically. */
function fakeClient(devices: RegistryDevice[]): {
  client: MbregistryClient;
  emit: (event: WatchEvent) => void;
  endWatch: () => void;
} {
  const queue: WatchEvent[] = [];
  const waiters: Array<(v: IteratorResult<WatchEvent>) => void> = [];
  let ended = false;

  function emit(event: WatchEvent): void {
    const waiter = waiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      queue.push(event);
    }
  }

  function endWatch(): void {
    ended = true;
    for (const waiter of waiters.splice(0)) {
      waiter({ value: undefined as unknown as WatchEvent, done: true });
    }
  }

  const client: MbregistryClient = {
    async connect(): Promise<ResolvedEndpoint> {
      return ENDPOINT;
    },
    close(): void {
      endWatch();
    },
    async list(): Promise<RegistryDevice[]> {
      return devices;
    },
    async find(uid: string): Promise<RegistryDevice> {
      const found = devices.find((d) => d.uid === uid);
      if (!found) {
        throw new Error(`not found: ${uid}`);
      }
      return found;
    },
    async lock(): Promise<void> {
      throw new Error("not used by this watcher");
    },
    async unlock(): Promise<boolean> {
      throw new Error("not used by this watcher");
    },
    watch(): AsyncIterable<WatchEvent> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<WatchEvent> {
          return {
            next(): Promise<IteratorResult<WatchEvent>> {
              const queued = queue.shift();
              if (queued !== undefined) {
                return Promise.resolve({ value: queued, done: false });
              }
              if (ended) {
                return Promise.resolve({ value: undefined as unknown as WatchEvent, done: true });
              }
              return new Promise((resolve) => waiters.push(resolve));
            },
          };
        },
      };
    },
    async stream(): Promise<{ socket: never; unlockAndClose: () => void }> {
      throw new Error("not used by this watcher");
    },
    resolvedEndpoint: ENDPOINT,
    remotePort: undefined,
  };

  return { client, emit, endWatch };
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

function startWatcher(store: Store, client: MbregistryClient, deps: Partial<MbregistryWatcherDeps> = {}) {
  return startMbregistryWatcher(store, { client, now: () => Date.now(), ...deps });
}

describe("startMbregistryWatcher", () => {
  it("list() yields a devices row and a connectable, owned links(mbregistry) row with the documented field mapping", async () => {
    const store = freshStore();
    const { client } = fakeClient([vevovDevice()]);
    const handle = startWatcher(store, client);

    await waitFor(() => store.snapshotRows().devices.length > 0);

    const device = store.snapshotRows().devices.find((d) => d.id === VEVOV_ID);
    expect(device).toBeDefined();
    expect(device?.name).toBe(VEVOV_NAME);
    expect(device?.usb_serial).toBe("usb:vevov");
    expect(Number(device?.owned)).toBe(1);

    const link = store.snapshotRows().links.find((l) => l.id === "mbregistry-usb:vevov");
    expect(link).toBeDefined();
    expect(link?.transport).toBe("mbregistry");
    expect(link?.device_id).toBe(VEVOV_ID);
    expect(link?.state).toBe("connectable");
    // Sprint 018 ticket 006: the link address carries the *device's own*
    // routing info (`RegistryDevice.endpoint`/`.host`, null for a device
    // local to this console's own instance) -- not this client's own
    // `resolvedEndpoint`, which every row previously carried identically
    // regardless of which device it was for.
    expect(JSON.parse(link?.address as string)).toEqual({ endpoint: null, host: null, uid: "usb:vevov" });

    handle.stop();
  });

  it("an unidentified list entry writes a discovered link with no device row", async () => {
    const store = freshStore();
    const { client } = fakeClient([registryDevice({ uid: "usb:unprobed" })]);
    const handle = startWatcher(store, client);

    await waitFor(() => store.snapshotRows().links.length > 0);

    expect(store.snapshotRows().devices).toHaveLength(0);
    const link = store.snapshotRows().links.find((l) => l.id === "mbregistry-usb:unprobed");
    expect(link?.device_id).toBeNull();
    expect(link?.state).toBe("discovered");

    handle.stop();
  });

  it("the owned rule: a remote peer's device (host set) is written but never marked owned or connectable", async () => {
    const store = freshStore();
    const { client } = fakeClient([vevovDevice({ uid: "usb:remote-vevov", host: "other-console" })]);
    const handle = startWatcher(store, client);

    await waitFor(() => store.snapshotRows().devices.length > 0);

    const device = store.snapshotRows().devices.find((d) => d.id === VEVOV_ID);
    expect(Number(device?.owned)).toBe(0);
    const link = store.snapshotRows().links.find((l) => l.id === "mbregistry-usb:remote-vevov");
    expect(link?.state).toBe("discovered");

    handle.stop();
  });

  // Sprint 018 ticket 006 (closing a gap flagged by ticket 004's own
  // Implementation Notes): a peer-owned `list` entry's own `endpoint`/
  // `host` -- not this client's `resolvedEndpoint` -- are persisted into
  // the link row's address, so connect/flash routing (`connect/
  // connector.ts`'s `createMbregistryStream` default, `server.ts#
  // runFlashTask`) can dial the peer directly from the stored row,
  // without a live `mbregistryClient.find()` round-trip.
  it("persists a remote peer device's own endpoint/host into the link address", async () => {
    const store = freshStore();
    const { client } = fakeClient([
      vevovDevice({ uid: "usb:remote-vevov", host: "other-console", endpoint: "10.0.0.9:9100" }),
    ]);
    const handle = startWatcher(store, client);

    await waitFor(() => store.snapshotRows().links.length > 0);

    const link = store.snapshotRows().links.find((l) => l.id === "mbregistry-usb:remote-vevov");
    expect(JSON.parse(link?.address as string)).toEqual({
      endpoint: "10.0.0.9:9100",
      host: "other-console",
      uid: "usb:remote-vevov",
    });

    handle.stop();
  });

  it("watch() identity event upserts devices/links without a full re-list, and promotes to connectable", async () => {
    const store = freshStore();
    const { client, emit } = fakeClient([registryDevice({ uid: "usb:vevov" })]);
    const handle = startWatcher(store, client);

    await waitFor(() => store.snapshotRows().links.length > 0);
    expect(store.snapshotRows().devices).toHaveLength(0);

    emit({
      type: "identity",
      host: "this-console",
      uid: "usb:vevov",
      state: "connected",
      role: "NEZHA2",
      common_name: "robot",
      device_name: VEVOV_NAME,
      serial_payload: String(VEVOV_ID),
      raw_announcement: `device NEZHA2 robot ${VEVOV_NAME} ${VEVOV_ID}`,
    });

    await waitFor(() => store.snapshotRows().devices.length > 0);
    const device = store.snapshotRows().devices.find((d) => d.id === VEVOV_ID);
    expect(device?.name).toBe(VEVOV_NAME);
    expect(Number(device?.owned)).toBe(1);
    const link = store.snapshotRows().links.find((l) => l.id === "mbregistry-usb:vevov");
    expect(link?.device_id).toBe(VEVOV_ID);
    expect(link?.state).toBe("connectable");

    handle.stop();
  });

  it("watch() attach event creates a discovered link with no device yet", async () => {
    const store = freshStore();
    const { client, emit } = fakeClient([]);
    const handle = startWatcher(store, client);

    // Wait for `list()` (empty here) to complete and heartbeat once,
    // so `watch()` is definitely the active consumer before emitting.
    await waitFor(() => store.snapshotRows().tasks.some((t) => t.name === "mbregistryWatcher"));
    emit({ type: "attach", host: "this-console", uid: "usb:new-board", port: "/dev/ttyACM3", vid_pid: "0d28:0204" });

    await waitFor(() => store.snapshotRows().links.some((l) => l.id === "mbregistry-usb:new-board"));
    const link = store.snapshotRows().links.find((l) => l.id === "mbregistry-usb:new-board");
    expect(link?.state).toBe("discovered");
    expect(link?.device_id).toBeNull();

    handle.stop();
  });

  it("watch() detach ages the link stale and closes any open session, without releasing an owner (mbregistry owns exclusivity)", async () => {
    const store = freshStore();
    const { client, emit } = fakeClient([vevovDevice()]);
    const handle = startWatcher(store, client);

    await waitFor(() => store.snapshotRows().links.some((l) => l.id === "mbregistry-usb:vevov"));
    store.openSession("mbregistry-usb:vevov", Date.now());
    expect(store.snapshotRows().sessions).toHaveLength(1);

    emit({ type: "detach", host: "this-console", uid: "usb:vevov" });

    await waitFor(() => store.snapshotRows().links.find((l) => l.id === "mbregistry-usb:vevov")?.state === "stale");
    expect(store.snapshotRows().sessions).toHaveLength(0);
    // The device row itself is untouched -- only the link/session react.
    expect(store.snapshotRows().devices.find((d) => d.id === VEVOV_ID)).toBeDefined();

    handle.stop();
  });

  it("watch() lock_state refreshes the link's last_seen without altering its device/state", async () => {
    const store = freshStore();
    const { client, emit } = fakeClient([vevovDevice()]);
    const handle = startWatcher(store, client);

    await waitFor(() => store.snapshotRows().links.some((l) => l.id === "mbregistry-usb:vevov"));
    const before = store.snapshotRows().links.find((l) => l.id === "mbregistry-usb:vevov");
    const beforeLastSeen = Number(before?.last_seen);

    await new Promise((resolve) => setTimeout(resolve, 5));
    emit({
      type: "lock_state",
      host: "this-console",
      uid: "usb:vevov",
      kind: "serial",
      display: "alice",
      label: "alice",
      since: Date.now() / 1000,
    });

    await waitFor(() => Number(store.snapshotRows().links.find((l) => l.id === "mbregistry-usb:vevov")?.last_seen) > beforeLastSeen);
    const after = store.snapshotRows().links.find((l) => l.id === "mbregistry-usb:vevov");
    expect(after?.device_id).toBe(VEVOV_ID);
    expect(after?.state).toBe("connectable");

    handle.stop();
  });

  it("merges a known-robots-style name placeholder once mbregistry identifies the same name", async () => {
    const store = freshStore();
    const placeholderId = nameToValue(VEVOV_NAME);
    store.upsertDevice({ id: placeholderId, name: VEVOV_NAME, kind: "robot", at: Date.now() });
    store.setOwned(placeholderId, true, Date.now());

    const { client } = fakeClient([vevovDevice({ uid: "usb:vevov-real" })]);
    const handle = startWatcher(store, client);

    await waitFor(() => store.snapshotRows().devices.some((d) => d.id === VEVOV_ID));

    // The placeholder row is gone -- merged into the real, mbregistry-identified row.
    expect(store.snapshotRows().devices.find((d) => d.id === placeholderId)).toBeUndefined();
    const merged = store.snapshotRows().devices.find((d) => d.id === VEVOV_ID);
    expect(merged?.name).toBe(VEVOV_NAME);
    expect(Number(merged?.owned)).toBe(1);

    handle.stop();
  });

  it("heartbeats the mbregistryWatcher task after list() and after every watch() event", async () => {
    const store = freshStore();
    const { client, emit } = fakeClient([vevovDevice()]);
    const handle = startWatcher(store, client);

    await waitFor(() => store.snapshotRows().tasks.some((t) => t.name === "mbregistryWatcher"));
    const afterList = store.snapshotRows().tasks.find((t) => t.name === "mbregistryWatcher");
    expect(afterList).toBeDefined();
    const firstHeartbeat = Number(afterList?.heartbeat_at);

    await new Promise((resolve) => setTimeout(resolve, 5));
    emit({ type: "detach", host: "this-console", uid: "usb:vevov" });

    await waitFor(
      () => Number(store.snapshotRows().tasks.find((t) => t.name === "mbregistryWatcher")?.heartbeat_at) > firstHeartbeat,
    );

    handle.stop();
  });

  // Bench fix 010 -- real mbregistry v0.20260924.7 bench pass: a
  // previously-plugged, now-unplugged device ("gone" in mbregistry's own
  // CLI render, `state: "disconnected"` on the wire) was being treated as
  // connectable and auto-connected/retried forever.
  describe("bench fix 010: disconnected (\"gone\") list entries", () => {
    it("a disconnected list entry never promotes to connectable and never sets owned", async () => {
      const store = freshStore();
      const { client } = fakeClient([vevovDevice({ state: "disconnected" })]);
      const handle = startWatcher(store, client);

      await waitFor(() => store.snapshotRows().links.some((l) => l.id === "mbregistry-usb:vevov"));

      const link = store.snapshotRows().links.find((l) => l.id === "mbregistry-usb:vevov");
      expect(link?.state).toBe("stale");
      const device = store.snapshotRows().devices.find((d) => d.id === VEVOV_ID);
      expect(device).toBeDefined();
      expect(Number(device?.owned)).toBe(0);

      handle.stop();
    });

    it("marks an already-connectable link stale once a later list() reports it disconnected", async () => {
      const store = freshStore();
      const { client } = fakeClient([vevovDevice()]);
      const handle = startWatcher(store, client);

      await waitFor(
        () => store.snapshotRows().links.find((l) => l.id === "mbregistry-usb:vevov")?.state === "connectable",
      );

      // Same watcher instance, driven by a second, independent list()
      // reporting the device gone -- exercises `upsertFromListEntry`'s
      // own disconnected branch downgrading a link this same run already
      // promoted, not just a link seen disconnected from the start.
      const secondList = fakeClient([vevovDevice({ state: "disconnected" })]);
      const handle2 = startWatcher(store, secondList.client);
      await waitFor(() => store.snapshotRows().links.find((l) => l.id === "mbregistry-usb:vevov")?.state === "stale");

      handle.stop();
      handle2.stop();
    });

    it("a device replugged after being disconnected becomes connectable again via a later identity event", async () => {
      const store = freshStore();
      const { client, emit } = fakeClient([vevovDevice({ state: "disconnected" })]);
      const handle = startWatcher(store, client);

      await waitFor(() => store.snapshotRows().links.find((l) => l.id === "mbregistry-usb:vevov")?.state === "stale");

      emit({
        type: "identity",
        host: "this-console",
        uid: "usb:vevov",
        state: "connected",
        role: "NEZHA2",
        common_name: "robot",
        device_name: VEVOV_NAME,
        serial_payload: String(VEVOV_ID),
        raw_announcement: `device NEZHA2 robot ${VEVOV_NAME} ${VEVOV_ID}`,
      });

      await waitFor(
        () => store.snapshotRows().links.find((l) => l.id === "mbregistry-usb:vevov")?.state === "connectable",
      );
      const device = store.snapshotRows().devices.find((d) => d.id === VEVOV_ID);
      expect(Number(device?.owned)).toBe(1);

      handle.stop();
    });
  });

  // Bench fix 010 -- the same bench pass found `vutev`, a device
  // announcing a role/commonName `classifyBanner` doesn't recognize at
  // all, stored with `devices.kind = "robot"`. Sprint 023 gave
  // `classifyBanner` a `"joystick"` type for role `JOYSTICK` (a
  // micro:bit running the student joystick firmware), so that role no
  // longer exercises this "genuinely unrecognized" path -- this fixture
  // now uses a role `classifyBanner` has no allowlist entry for at all.
  describe("bench fix 010: unrecognized banner is not labeled a robot", () => {
    function unrecognizedDevice(overrides: Partial<RegistryDevice> = {}): RegistryDevice {
      return registryDevice({
        uid: "usb:vutev",
        role: "ROBOTV7",
        common_name: null,
        device_name: "vutev",
        serial_payload: "12345",
        raw_announcement: "device ROBOTV7 vutev 12345",
        state: "connected",
        ...overrides,
      });
    }

    it("a list() entry with an unrecognized banner is not upserted as devices.kind = robot -- no devices row at all", async () => {
      const store = freshStore();
      const { client } = fakeClient([unrecognizedDevice()]);
      const handle = startWatcher(store, client);

      await waitFor(() => store.snapshotRows().links.some((l) => l.id === "mbregistry-usb:vutev"));

      expect(store.snapshotRows().devices).toHaveLength(0);
      const link = store.snapshotRows().links.find((l) => l.id === "mbregistry-usb:vutev");
      expect(link?.device_id).toBeNull();
      expect(link?.state).toBe("discovered");

      handle.stop();
    });

    it("a watch() identity event with an unrecognized banner is likewise not upserted as a robot", async () => {
      const store = freshStore();
      const { client, emit } = fakeClient([registryDevice({ uid: "usb:vutev" })]);
      const handle = startWatcher(store, client);

      await waitFor(() => store.snapshotRows().links.some((l) => l.id === "mbregistry-usb:vutev"));

      emit({
        type: "identity",
        host: "this-console",
        uid: "usb:vutev",
        state: "connected",
        role: "ROBOTV7",
        common_name: null,
        device_name: "vutev",
        serial_payload: "12345",
        raw_announcement: "device ROBOTV7 vutev 12345",
      });

      // Give the (non-)upsert a moment to happen -- there is no positive
      // condition to wait on here, only the absence of a devices row.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(store.snapshotRows().devices).toHaveLength(0);
      const link = store.snapshotRows().links.find((l) => l.id === "mbregistry-usb:vutev");
      expect(link?.device_id).toBeNull();

      handle.stop();
    });
  });

  // Sprint 023 gave `classifyBanner` a "joystick" DeviceType (a
  // micro:bit running the student joystick firmware) -- this watcher's
  // own `classifyDeviceKind` must map that through to `devices.kind =
  // "joystick"`, not fall into the "unrecognized" bucket the suite
  // above covers (a role `classifyBanner` genuinely has no allowlist
  // entry for).
  it("a JOYSTICK-role banner is upserted as devices.kind = joystick", async () => {
    const store = freshStore();
    const { client } = fakeClient([
      registryDevice({
        uid: "usb:gopiv",
        role: "JOYSTICK",
        common_name: null,
        device_name: "gopiv",
        serial_payload: "2175407711",
        raw_announcement: "DEVICE:JOYSTICK:joystick:gopiv:2175407711",
        state: "connected",
      }),
    ]);
    const handle = startWatcher(store, client);

    await waitFor(() => store.snapshotRows().devices.some((d) => d.name === "gopiv"));

    const device = store.snapshotRows().devices.find((d) => d.name === "gopiv");
    expect(device?.kind).toBe("joystick");

    handle.stop();
  });
});
