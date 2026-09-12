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
import { openStore, type ProjectionRows, type Store } from "./store/index.js";

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
      expect(snapshot.relays).toEqual([{ linkId: "usb-relay-1", lease: "sweep" }]);
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
  };
}

describe("buildSnapshotFromRows: capabilities", () => {
  it("a usb link with no open session: open/flash true, close/provisionWifi false", () => {
    const rows = emptyRows();
    rows.devices = [
      { id: 10, name: deviceIdToName(10), kind: "robot", role: null, program: null, version: null, radioChannel: null, radioGroup: null, radioSource: null, owned: true, lastSeen: 1 },
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
      { id: 10, name: deviceIdToName(10), kind: "robot", role: null, program: null, version: null, radioChannel: null, radioGroup: null, radioSource: null, owned: true, lastSeen: 1 },
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
      { id: 10, name: deviceIdToName(10), kind: "robot", role: null, program: null, version: null, radioChannel: null, radioGroup: null, radioSource: null, owned: true, lastSeen: 1 },
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
      { id: 10, name: deviceIdToName(10), kind: "robot", role: null, program: null, version: null, radioChannel: null, radioGroup: null, radioSource: null, owned: false, lastSeen: 1 },
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
      { id: 10, name: deviceIdToName(10), kind: "robot", role: null, program: null, version: null, radioChannel: null, radioGroup: null, radioSource: null, owned: true, lastSeen: 1 },
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
      { id: 10, name: deviceIdToName(10), kind: "robot", role: null, program: null, version: null, radioChannel: null, radioGroup: null, radioSource: null, owned: false, lastSeen: 1 },
    ];
    rows.links = [
      { id: "l1", deviceId: 10, transport: "mbserial", address: { host: "x", port: 1 }, state: "discovered", stateReason: null, stateSince: 1, lastSeen: 1, nextRetryAt: null, failCount: 0, userClosed: false },
    ];
    const snapshot = buildSnapshotFromRows(rows, 1, 1);
    expect(snapshot.devices).toHaveLength(0);
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
      { id: 10, name: derived, kind: "robot", role: null, program: null, version: null, radioChannel: 55, radioGroup: 114, radioSource: "override", owned: true, lastSeen: 1 },
    ];
    const snapshot = buildSnapshotFromRows(rows, 1, 1);
    expect(snapshot.devices[0]?.radio).toEqual({ channel: 55, group: 114, source: "override" });
  });

  it("radio-address resolution: no stored value falls back to the name-derived default, reported as 'derived'", () => {
    const rows = emptyRows();
    rows.devices = [
      { id: 10, name: "vevov", kind: "robot", role: null, program: null, version: null, radioChannel: null, radioGroup: null, radioSource: null, owned: true, lastSeen: 1 },
    ];
    const snapshot = buildSnapshotFromRows(rows, 1, 1);
    expect(snapshot.devices[0]?.radio.source).toBe("derived");
    expect(snapshot.devices[0]?.radio.channel).toEqual(expect.any(Number));
    expect(snapshot.devices[0]?.radio.group).toEqual(expect.any(Number));
  });
});
