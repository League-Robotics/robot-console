/**
 * projection.test.ts — `buildSnapshot`'s golden test (sprint 015 ticket
 * 004's own acceptance criterion: "seeded rows → buildSnapshot() equals
 * a checked-in fixture covering an owned robot with USB+WiFi+radio
 * links, an un-owned WiFi robot (absent), an unnamed USB board
 * (unassigned), and a relay under a sweep lease"), plus focused
 * capability-derivation edge cases against {@link buildSnapshotFromRows}
 * directly (no store, no SQLite -- a plain `ProjectionRows` object is
 * enough to exercise `capabilities`/`via`/hiding rules in isolation).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deviceIdToName } from "@robot-console/protocol";
import { describe, expect, it } from "vitest";
import { buildSnapshot, buildSnapshotFromRows } from "./projection.js";
import { MBFLASH_SERVICE_TYPE, openStore, type ProjectionRows, type Store } from "./store/index.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "projection.fixtures");

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), "utf8"));
}

const VEVOV_ID = 1198504156; // decodes to "vevov" -- same id store/index.test.ts already uses
const UNOWNED_ID = 1;
const RELAY_ID = 2;

/** Seeds the exact scenario `projection.fixtures/golden-snapshot.json`
 * was generated from -- an owned robot ("vevov") with an open-session
 * USB link plus WiFi and (relay-ridden) radio links, a relay device
 * under a sweep lease, an un-owned WiFi robot, and an unnamed USB
 * board. Kept in one place so a future re-generation of the fixture
 * reads exactly this function, never a hand-edited JSON diff. */
function seedGoldenScenario(store: Store): void {
  const unownedName = deviceIdToName(UNOWNED_ID);
  const relayName = deviceIdToName(RELAY_ID);

  store.upsertDevice({
    id: VEVOV_ID,
    name: "vevov",
    kind: "robot",
    role: "NEZHA2",
    program: "diffdrive",
    version: "1.20260907.5",
    usbSerial: "SERIAL-VEVOV",
    at: 100,
  });
  store.setOwned(VEVOV_ID, true, 100);

  store.upsertLink({ id: "usb-vevov", transport: "usb", address: { path: "/dev/tty.usbmodem-vevov" }, deviceId: VEVOV_ID, at: 100 });
  store.setLinkState({ id: "usb-vevov", state: "connected", at: 110 });
  store.openSession("usb-vevov", 110);
  store.updateSession("usb-vevov", {
    seq: 5,
    pending: 1,
    lastDone: 4,
    lastDoneReason: "ok",
    robotStatus: JSON.stringify({
      receivedAt: 120,
      fields: { flags: "1" },
      ready: true,
      active: true,
      estopped: false,
      stallHalted: false,
      leaseExpired: false,
    }),
    functions: [{ name: "drive", signature: "n n" }],
  });

  store.upsertLink({ id: "wifi-vevov", transport: "wifi", address: { host: "vevov.local", port: 7654 }, deviceId: VEVOV_ID, at: 130 });
  store.setLinkState({ id: "wifi-vevov", state: "connectable", at: 131 });

  store.upsertDevice({ id: RELAY_ID, name: relayName, kind: "relay", role: "RADIOBRIDGE", at: 90 });
  store.upsertLink({ id: "usb-relay-1", transport: "usb", address: { path: "/dev/tty.usbmodem-relay1" }, deviceId: RELAY_ID, at: 90 });
  store.setLinkState({ id: "usb-relay-1", state: "connectable", at: 91 });
  store.acquireRelayLease("usb-relay-1", "sweep", 92);

  store.upsertLink({
    id: "radio-vevov",
    transport: "radio",
    address: { relayLinkId: "usb-relay-1", channel: 41, group: 3 },
    deviceId: VEVOV_ID,
    at: 140,
  });
  store.setLinkState({ id: "radio-vevov", state: "connectable", at: 141 });

  store.recordSighting({ deviceId: VEVOV_ID, name: "vevov", transport: "radio", at: 150, ok: true });
  store.recordSighting({ deviceId: VEVOV_ID, name: "vevov", transport: "radio", at: 160, ok: true });

  store.upsertDevice({ id: UNOWNED_ID, name: unownedName, kind: "robot", at: 95 });
  store.upsertLink({
    id: `wifi-${unownedName}`,
    transport: "wifi",
    address: { host: `${unownedName}.local`, port: 7654 },
    deviceId: UNOWNED_ID,
    at: 96,
  });

  store.upsertLink({ id: "usb-unknown-1", transport: "usb", address: { path: "/dev/tty.usbmodem-unknown" }, at: 97 });

  store.setFirmware({ kind: "robot", repo: "League-Robotics/nezha-diffdrive", tag: "v1.2.3", available: true, checkedAt: 200 });
  store.setFirmware({ kind: "relay", available: false, reason: "not-configured", checkedAt: 200 });
  store.heartbeat("usbWatcher", 210, "polling");
  store.setSetting("wifiCredentials", JSON.stringify({ ssid: "classroom-net", password: "hunter2" }));
}

describe("buildSnapshot: golden fixture", () => {
  it("matches the checked-in golden-snapshot.json fixture exactly", () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      seedGoldenScenario(store);
      const snapshot = buildSnapshot(store, 7, 999999);
      expect(snapshot).toEqual(readFixture("golden-snapshot.json"));
    } finally {
      store.close();
    }
  });

  it("hides the un-owned WiFi robot's link and drops the device entirely (architecture.md §4/§9)", () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      seedGoldenScenario(store);
      const snapshot = buildSnapshot(store, 1, 1);
      expect(snapshot.devices.find((d) => d.id === UNOWNED_ID)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("drops a stale unassigned usb link (board no longer enumerated) from unassigned", () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      seedGoldenScenario(store);
      store.setLinkState({ id: "usb-unknown-1", state: "stale", at: 200 });
      const snapshot = buildSnapshot(store, 1, 1);
      expect(snapshot.unassigned).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("lists the unnamed USB board under unassigned, not under any device", () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      seedGoldenScenario(store);
      const snapshot = buildSnapshot(store, 1, 1);
      expect(snapshot.unassigned).toHaveLength(1);
      expect(snapshot.unassigned[0]?.id).toBe("usb-unknown-1");
      expect(snapshot.devices.some((d) => d.links.some((l) => l.id === "usb-unknown-1"))).toBe(false);
    } finally {
      store.close();
    }
  });

  it("reports the relay under its sweep lease", () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      seedGoldenScenario(store);
      const snapshot = buildSnapshot(store, 1, 1);
      expect(snapshot.relays).toEqual([{ linkId: "usb-relay-1", lease: "sweep", sweep: null }]);
    } finally {
      store.close();
    }
  });

  it("surfaces the fast-sweep rate once ticket 016-007's capability detection has recorded it (fast)", () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      seedGoldenScenario(store);
      store.setSetting("relaySweepFast:usb-relay-1", "1");
      const snapshot = buildSnapshot(store, 1, 1);
      expect(snapshot.relays).toEqual([{ linkId: "usb-relay-1", lease: "sweep", sweep: { rate: "fast" } }]);
    } finally {
      store.close();
    }
  });

  it("surfaces the fast-sweep rate as slow when detection recorded no capability (not merely unset)", () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      seedGoldenScenario(store);
      store.setSetting("relaySweepFast:usb-relay-1", "0");
      const snapshot = buildSnapshot(store, 1, 1);
      expect(snapshot.relays).toEqual([{ linkId: "usb-relay-1", lease: "sweep", sweep: { rate: "slow" } }]);
    } finally {
      store.close();
    }
  });

  it("grep smoke check: the retired vocabulary never reappears (ticket 004 acceptance criterion)", () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      seedGoldenScenario(store);
      const text = JSON.stringify(buildSnapshot(store, 1, 1));
      expect(text).not.toMatch(/EndpointListEntry|rememberedRobots|discoveredServices/);
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------
// relays[] -- a synthetic mbrelay pool device (ticket 016-005) shows up
// exactly like a local usb relay does (the golden fixture above only
// ever covers a usb-transport relay -- `buildRelays` itself keys purely
// off `device.kind === "relay"`, independent of the link's own
// transport, but this ticket adds a dedicated case rather than relying
// on that inference alone).
// ---------------------------------------------------------------------

describe("buildSnapshotFromRows: relays[] for a network (mbrelay) relay", () => {
  it("lists a synthetic mbrelay-transport relay device under relays[] the same as a usb one", () => {
    const rows = emptyRows();
    const relayName = deviceIdToName(20);
    rows.devices = [
      { id: 20, name: relayName, kind: "relay", role: "RADIOBRIDGE", commonName: null, program: null, version: null, radioChannel: null, radioGroup: null, radioSource: null, owned: false, lastSeen: 1 },
    ];
    rows.links = [
      {
        id: `mbrelay-${relayName}`,
        deviceId: 20,
        transport: "mbrelay",
        address: { host: `${relayName}.local`, port: 8760, registryPort: 8761 },
        state: "connectable",
        stateReason: null,
        stateSince: 1,
        lastSeen: 1,
        nextRetryAt: null,
        failCount: 0,
        userClosed: false,
      },
    ];
    rows.relayLeases = [{ relayLinkId: `mbrelay-${relayName}`, owner: "session:mbrelay-cand-via-relay" }];

    const snapshot = buildSnapshotFromRows(rows, 1, 1);
    expect(snapshot.relays).toEqual([{ linkId: `mbrelay-${relayName}`, lease: "session", sweep: null }]);
  });

  // -------------------------------------------------------------------
  // Ticket 017-005 (2026-09-12 architecture revision): a relay whose
  // mDNS instance name isn't a well-formed five-letter name (e.g. the
  // real bench pool "torture") gets a synthetic *negative* id instead
  // of `nameToValue`'s [0, 3124] range. `buildRelays` itself is
  // unaffected (keys purely off `kind === "relay"`, per this block's own
  // header comment) -- the real risk this fixture guards is
  // `resolveRadio`, which would otherwise call `nameToRadioAddress`
  // ("torture") and throw, taking the whole snapshot build down with
  // it, since `radio` is a required field on every device row.
  // -------------------------------------------------------------------
  it("lists a synthetic negative-id relay (non-grammar mDNS name 'torture') under relays[], without buildSnapshotFromRows throwing", () => {
    const rows = emptyRows();
    const TORTURE_ID = -123456789;
    rows.devices = [
      { id: TORTURE_ID, name: "torture", kind: "relay", role: null, commonName: null, program: null, version: null, radioChannel: null, radioGroup: null, radioSource: null, owned: false, lastSeen: 1 },
    ];
    rows.links = [
      {
        id: "mbrelay-torture",
        deviceId: TORTURE_ID,
        transport: "mbrelay",
        address: { host: "torture.local", port: 8760, registryPort: 8761 },
        state: "connectable",
        stateReason: null,
        stateSince: 1,
        lastSeen: 1,
        nextRetryAt: null,
        failCount: 0,
        userClosed: false,
      },
    ];
    rows.relayLeases = [{ relayLinkId: "mbrelay-torture", owner: "sweep" }];

    let snapshot: ReturnType<typeof buildSnapshotFromRows> | undefined;
    expect(() => {
      snapshot = buildSnapshotFromRows(rows, 1, 1);
    }).not.toThrow();

    expect(snapshot?.relays).toEqual([{ linkId: "mbrelay-torture", lease: "sweep", sweep: null }]);
    const device = snapshot?.devices.find((d) => d.id === TORTURE_ID);
    expect(device).toMatchObject({ id: TORTURE_ID, name: "torture", kind: "relay" });
    // No meaningful radio identity for this row -- see resolveRadio's
    // own doc comment -- but the field must still be present and
    // concrete (never absent, never a thrown error).
    expect(device?.radio).toEqual({ channel: 0, group: 0, source: "derived" });
    // Bench defect (team-lead walk 017-012, 2026-09-13): this link's own
    // label read "mbrelay · ch?/grp?" -- `buildLabel`'s mbrelay case
    // called `channelGroup` on an address shaped `{ host, port,
    // registryPort }` (mdnsWatcher.ts's `handleMbrelay`), which has no
    // `channel`/`group` fields at all. It must read the same host:port
    // shape `wifi`/`mbserial` already do.
    expect(device?.links[0]?.label).toBe("mbrelay · torture.local:8760");
  });
});

// ---------------------------------------------------------------------
// capabilities -- table-driven edge cases against buildSnapshotFromRows
// ---------------------------------------------------------------------

function emptyRows(): ProjectionRows {
  return {
    devices: [],
    links: [],
    sessions: [],
    relayLeases: [],
    firmware: [],
    tasks: [],
    lastChecked: [],
    wifiCredentials: null,
    fastSweepByRelayLinkId: new Map(),
    services: [],
  };
}

describe("buildSnapshotFromRows: capabilities", () => {
  it("a usb link with no open session: open/flash true, close/provisionWifi false", () => {
    const rows = emptyRows();
    rows.devices = [
      { id: 10, name: deviceIdToName(10), kind: "robot", role: null, commonName: null, program: null, version: null, radioChannel: null, radioGroup: null, radioSource: null, owned: true, lastSeen: 1 },
    ];
    rows.links = [
      { id: "l1", deviceId: 10, transport: "usb", address: { path: "/dev/x" }, state: "connectable", stateReason: null, stateSince: 1, lastSeen: 1, nextRetryAt: null, failCount: 0, userClosed: false },
    ];
    const snapshot = buildSnapshotFromRows(rows, 1, 1);
    const link = snapshot.devices[0]?.links[0];
    expect(link?.capabilities).toEqual({ open: true, close: false, flash: true, provisionWifi: false });
  });

  it("a link with an open session: open false, close/provisionWifi true", () => {
    const rows = emptyRows();
    rows.devices = [
      { id: 10, name: deviceIdToName(10), kind: "robot", role: null, commonName: null, program: null, version: null, radioChannel: null, radioGroup: null, radioSource: null, owned: true, lastSeen: 1 },
    ];
    rows.links = [
      { id: "l1", deviceId: 10, transport: "usb", address: { path: "/dev/x" }, state: "connected", stateReason: null, stateSince: 1, lastSeen: 1, nextRetryAt: null, failCount: 0, userClosed: false },
    ];
    rows.sessions = [{ linkId: "l1", seq: null, pending: null, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null }];
    const snapshot = buildSnapshotFromRows(rows, 1, 1);
    const link = snapshot.devices[0]?.links[0];
    expect(link?.capabilities).toEqual({ open: false, close: true, flash: true, provisionWifi: true });
    // seq/pending default to 0 when a session has just opened (both still null in the row).
    expect(link?.session).toEqual({ seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null });
  });

  it("a link in state connecting (no session row yet): close true, open false", () => {
    const rows = emptyRows();
    rows.devices = [
      { id: 10, name: deviceIdToName(10), kind: "robot", role: null, commonName: null, program: null, version: null, radioChannel: null, radioGroup: null, radioSource: null, owned: true, lastSeen: 1 },
    ];
    rows.links = [
      { id: "l1", deviceId: 10, transport: "usb", address: { path: "/dev/x" }, state: "connecting", stateReason: null, stateSince: 1, lastSeen: 1, nextRetryAt: null, failCount: 0, userClosed: false },
    ];
    const snapshot = buildSnapshotFromRows(rows, 1, 1);
    expect(snapshot.devices[0]?.links[0]?.capabilities).toEqual({ open: false, close: true, flash: true, provisionWifi: false });
  });

  it("a wifi link on an un-owned device is hidden -- never reaches capabilities at all", () => {
    const rows = emptyRows();
    rows.devices = [
      { id: 10, name: deviceIdToName(10), kind: "robot", role: null, commonName: null, program: null, version: null, radioChannel: null, radioGroup: null, radioSource: null, owned: false, lastSeen: 1 },
    ];
    rows.links = [
      { id: "l1", deviceId: 10, transport: "wifi", address: { host: "x", port: 1 }, state: "discovered", stateReason: null, stateSince: 1, lastSeen: 1, nextRetryAt: null, failCount: 0, userClosed: false },
    ];
    const snapshot = buildSnapshotFromRows(rows, 1, 1);
    expect(snapshot.devices).toHaveLength(0);
  });

  it("a wifi link on an owned device: open true (not gated by ownership once owned)", () => {
    const rows = emptyRows();
    rows.devices = [
      { id: 10, name: deviceIdToName(10), kind: "robot", role: null, commonName: null, program: null, version: null, radioChannel: null, radioGroup: null, radioSource: null, owned: true, lastSeen: 1 },
    ];
    rows.links = [
      { id: "l1", deviceId: 10, transport: "wifi", address: { host: "x", port: 1 }, state: "discovered", stateReason: null, stateSince: 1, lastSeen: 1, nextRetryAt: null, failCount: 0, userClosed: false },
    ];
    const snapshot = buildSnapshotFromRows(rows, 1, 1);
    expect(snapshot.devices[0]?.links[0]?.capabilities.open).toBe(true);
    expect(snapshot.devices[0]?.links[0]?.capabilities.flash).toBe(false);
  });

  it("a mbserial link on an un-owned device is hidden the same way wifi is", () => {
    const rows = emptyRows();
    rows.devices = [
      { id: 10, name: deviceIdToName(10), kind: "robot", role: null, commonName: null, program: null, version: null, radioChannel: null, radioGroup: null, radioSource: null, owned: false, lastSeen: 1 },
    ];
    rows.links = [
      { id: "l1", deviceId: 10, transport: "mbserial", address: { host: "x", port: 1 }, state: "discovered", stateReason: null, stateSince: 1, lastSeen: 1, nextRetryAt: null, failCount: 0, userClosed: false },
    ];
    const snapshot = buildSnapshotFromRows(rows, 1, 1);
    expect(snapshot.devices).toHaveLength(0);
  });

  // Ticket 018-014: capabilities.flash for a mbserial/wifi link, gated
  // on the device's own current `_mbflash._tcp` service row.
  it("a mbserial link on an owned device with a current _mbflash._tcp service (instance = device name): flash true", () => {
    const rows = emptyRows();
    const name = deviceIdToName(10);
    rows.devices = [
      { id: 10, name, kind: "robot", role: null, commonName: null, program: null, version: null, radioChannel: null, radioGroup: null, radioSource: null, owned: true, lastSeen: 1 },
    ];
    rows.links = [
      { id: "l1", deviceId: 10, transport: "mbserial", address: { host: "x", port: 1 }, state: "connectable", stateReason: null, stateSince: 1, lastSeen: 1, nextRetryAt: null, failCount: 0, userClosed: false },
    ];
    rows.services = [{ instance: name, type: MBFLASH_SERVICE_TYPE, host: "x.local", port: 9000, txt: { role: "NEZHA2" } }];
    const snapshot = buildSnapshotFromRows(rows, 1, 1);
    expect(snapshot.devices[0]?.links[0]?.capabilities.flash).toBe(true);
  });

  it("a wifi link on an owned device with a current _mbflash._tcp service: flash true (wifi, not only mbserial)", () => {
    const rows = emptyRows();
    const name = deviceIdToName(11);
    rows.devices = [
      { id: 11, name, kind: "robot", role: null, commonName: null, program: null, version: null, radioChannel: null, radioGroup: null, radioSource: null, owned: true, lastSeen: 1 },
    ];
    rows.links = [
      { id: "l1", deviceId: 11, transport: "wifi", address: { host: "x", port: 1 }, state: "connectable", stateReason: null, stateSince: 1, lastSeen: 1, nextRetryAt: null, failCount: 0, userClosed: false },
    ];
    rows.services = [{ instance: name, type: MBFLASH_SERVICE_TYPE, host: "x.local", port: 9000, txt: null }];
    const snapshot = buildSnapshotFromRows(rows, 1, 1);
    expect(snapshot.devices[0]?.links[0]?.capabilities.flash).toBe(true);
  });

  it("a mbserial link on an owned device with NO matching service row: flash stays false", () => {
    const rows = emptyRows();
    const name = deviceIdToName(12);
    rows.devices = [
      { id: 12, name, kind: "robot", role: null, commonName: null, program: null, version: null, radioChannel: null, radioGroup: null, radioSource: null, owned: true, lastSeen: 1 },
    ];
    rows.links = [
      { id: "l1", deviceId: 12, transport: "mbserial", address: { host: "x", port: 1 }, state: "connectable", stateReason: null, stateSince: 1, lastSeen: 1, nextRetryAt: null, failCount: 0, userClosed: false },
    ];
    // A service row exists, but for a different instance name entirely
    // -- must not be mistaken for this device's own advertisement.
    rows.services = [{ instance: "someone-else", type: MBFLASH_SERVICE_TYPE, host: "x.local", port: 9000, txt: null }];
    const snapshot = buildSnapshotFromRows(rows, 1, 1);
    expect(snapshot.devices[0]?.links[0]?.capabilities.flash).toBe(false);
  });

  it("a service row of a different services.type (e.g. mbserial.tcp) never counts as a flash service", () => {
    const rows = emptyRows();
    const name = deviceIdToName(13);
    rows.devices = [
      { id: 13, name, kind: "robot", role: null, commonName: null, program: null, version: null, radioChannel: null, radioGroup: null, radioSource: null, owned: true, lastSeen: 1 },
    ];
    rows.links = [
      { id: "l1", deviceId: 13, transport: "mbserial", address: { host: "x", port: 1 }, state: "connectable", stateReason: null, stateSince: 1, lastSeen: 1, nextRetryAt: null, failCount: 0, userClosed: false },
    ];
    rows.services = [{ instance: name, type: "mbserial.tcp", host: "x.local", port: 9000, txt: null }];
    const snapshot = buildSnapshotFromRows(rows, 1, 1);
    expect(snapshot.devices[0]?.links[0]?.capabilities.flash).toBe(false);
  });

  it("device usbSerial and service TXT uid both present and matching: flash true", () => {
    const rows = emptyRows();
    const name = deviceIdToName(14);
    rows.devices = [
      { id: 14, name, kind: "robot", role: null, commonName: null, program: null, version: null, usbSerial: "SERIAL-XYZ", radioChannel: null, radioGroup: null, radioSource: null, owned: true, lastSeen: 1 },
    ];
    rows.links = [
      { id: "l1", deviceId: 14, transport: "mbserial", address: { host: "x", port: 1 }, state: "connectable", stateReason: null, stateSince: 1, lastSeen: 1, nextRetryAt: null, failCount: 0, userClosed: false },
    ];
    rows.services = [{ instance: name, type: MBFLASH_SERVICE_TYPE, host: "x.local", port: 9000, txt: { uid: "SERIAL-XYZ" } }];
    const snapshot = buildSnapshotFromRows(rows, 1, 1);
    expect(snapshot.devices[0]?.links[0]?.capabilities.flash).toBe(true);
  });

  it("device usbSerial and service TXT uid both present but disagreeing: flash false, even though the instance name matches", () => {
    const rows = emptyRows();
    const name = deviceIdToName(15);
    rows.devices = [
      { id: 15, name, kind: "robot", role: null, commonName: null, program: null, version: null, usbSerial: "SERIAL-XYZ", radioChannel: null, radioGroup: null, radioSource: null, owned: true, lastSeen: 1 },
    ];
    rows.links = [
      { id: "l1", deviceId: 15, transport: "mbserial", address: { host: "x", port: 1 }, state: "connectable", stateReason: null, stateSince: 1, lastSeen: 1, nextRetryAt: null, failCount: 0, userClosed: false },
    ];
    rows.services = [{ instance: name, type: MBFLASH_SERVICE_TYPE, host: "x.local", port: 9000, txt: { uid: "SOME-OTHER-SERIAL" } }];
    const snapshot = buildSnapshotFromRows(rows, 1, 1);
    expect(snapshot.devices[0]?.links[0]?.capabilities.flash).toBe(false);
  });

  it("a radio link on a device with a current _mbflash._tcp service: flash stays false (network flash never applies through a relay)", () => {
    const rows = emptyRows();
    const name = deviceIdToName(16);
    rows.devices = [
      { id: 16, name, kind: "robot", role: null, commonName: null, program: null, version: null, radioChannel: null, radioGroup: null, radioSource: null, owned: true, lastSeen: 1 },
      { id: 17, name: deviceIdToName(17), kind: "relay", role: null, commonName: null, program: null, version: null, radioChannel: null, radioGroup: null, radioSource: null, owned: true, lastSeen: 1 },
    ];
    rows.links = [
      { id: "relay-link", deviceId: 17, transport: "usb", address: { path: "/dev/x" }, state: "connected", stateReason: null, stateSince: 1, lastSeen: 1, nextRetryAt: null, failCount: 0, userClosed: false },
      { id: "l1", deviceId: 16, transport: "radio", address: { relayLinkId: "relay-link", channel: 1, group: 1 }, state: "connectable", stateReason: null, stateSince: 1, lastSeen: 1, nextRetryAt: null, failCount: 0, userClosed: false },
    ];
    rows.services = [{ instance: name, type: MBFLASH_SERVICE_TYPE, host: "x.local", port: 9000, txt: null }];
    const snapshot = buildSnapshotFromRows(rows, 1, 1);
    const radioDevice = snapshot.devices.find((d) => d.id === 16);
    expect(radioDevice?.links[0]?.capabilities.flash).toBe(false);
  });

  it("an unassigned usb link (no device yet) is still open-able and flashable", () => {
    const rows = emptyRows();
    rows.links = [
      { id: "l1", deviceId: null, transport: "usb", address: { path: "/dev/x" }, state: "discovered", stateReason: null, stateSince: 1, lastSeen: 1, nextRetryAt: null, failCount: 0, userClosed: false },
    ];
    const snapshot = buildSnapshotFromRows(rows, 1, 1);
    expect(snapshot.unassigned).toHaveLength(1);
    expect(snapshot.unassigned[0]?.capabilities).toEqual({ open: true, close: false, flash: true, provisionWifi: false });
  });

  it("radio-address resolution: an override on the device wins over the name-derived default", () => {
    const rows = emptyRows();
    const derived = deviceIdToName(10);
    rows.devices = [
      { id: 10, name: derived, kind: "robot", role: null, commonName: null, program: null, version: null, radioChannel: 55, radioGroup: 114, radioSource: "override", owned: true, lastSeen: 1 },
    ];
    const snapshot = buildSnapshotFromRows(rows, 1, 1);
    expect(snapshot.devices[0]?.radio).toEqual({ channel: 55, group: 114, source: "override" });
  });

  it("radio-address resolution: no stored value falls back to the name-derived default, reported as 'derived'", () => {
    const rows = emptyRows();
    rows.devices = [
      { id: 10, name: "vevov", kind: "robot", role: null, commonName: null, program: null, version: null, radioChannel: null, radioGroup: null, radioSource: null, owned: true, lastSeen: 1 },
    ];
    const snapshot = buildSnapshotFromRows(rows, 1, 1);
    expect(snapshot.devices[0]?.radio.source).toBe("derived");
    expect(snapshot.devices[0]?.radio.channel).toEqual(expect.any(Number));
    expect(snapshot.devices[0]?.radio.group).toEqual(expect.any(Number));
  });
});
