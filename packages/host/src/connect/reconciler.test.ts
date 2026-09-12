import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deviceIdToName } from "@robot-console/protocol";
import { openStoreDb } from "../store/db.js";
import { Store, type ReconcilerDeviceRow, type ReconcilerLinkRow, type ReconcilerRows, type Transport } from "../store/index.js";
import { FakeByteStream } from "../link/__fixtures__/FakeByteStream.js";
import { realScheduler, type Scheduler } from "../link/pacing.js";
import { createConnector, type Connector, type ConnectedSession } from "./connector.js";
import { plan, planUserClose, planUserOpen, startReconciler } from "./reconciler.js";

// Sprint 015 ticket 002's own suite: table-driven `plan()`/`planUserOpen`/
// `planUserClose` cases (pure, no store or network access at all), plus
// an executor integration section reusing ticket 001's own fake-`ByteStream`
// harness against a real, temp-dir-backed `Store`.

const NOW = 1_000_000;

function deviceRow(id: number, owned: boolean): ReconcilerDeviceRow {
  return { id, kind: "robot", owned };
}

function linkRow(
  partial: Partial<ReconcilerLinkRow> & { id: string; transport: Transport },
): ReconcilerLinkRow {
  return {
    deviceId: null,
    address: {},
    state: "connectable",
    nextRetryAt: null,
    failCount: 0,
    userClosed: false,
    ...partial,
  };
}

function rows(partial: Partial<ReconcilerRows>): ReconcilerRows {
  return { devices: [], links: [], sessions: [], relayLeases: [], ...partial };
}

// ---------------------------------------------------------------------
// plan() -- the automatic per-device pass (rules 1-4, ticket Description)
// ---------------------------------------------------------------------

describe("plan() -- pure per-device connect decisions", () => {
  it("is a pure function: the identical (rows, now) input always produces the identical Job[] output", () => {
    const input = rows({
      devices: [deviceRow(1, true)],
      links: [linkRow({ id: "wifi-1", transport: "wifi", deviceId: 1 })],
    });
    expect(plan(input, NOW)).toEqual(plan(input, NOW));
    expect(plan(input, NOW)).toEqual([{ kind: "connect", linkId: "wifi-1" }]);
  });

  it("an owned wifi link with nothing connected -> a connect job", () => {
    const input = rows({
      devices: [deviceRow(1, true)],
      links: [linkRow({ id: "wifi-1", transport: "wifi", deviceId: 1 })],
    });
    expect(plan(input, NOW)).toEqual([{ kind: "connect", linkId: "wifi-1" }]);
  });

  it("an un-owned wifi link -> no job", () => {
    const input = rows({
      devices: [deviceRow(1, false)],
      links: [linkRow({ id: "wifi-1", transport: "wifi", deviceId: 1 })],
    });
    expect(plan(input, NOW)).toEqual([]);
  });

  it("an un-owned mbserial link -> no job", () => {
    const input = rows({
      devices: [deviceRow(1, false)],
      links: [linkRow({ id: "mbserial-1", transport: "mbserial", deviceId: 1 })],
    });
    expect(plan(input, NOW)).toEqual([]);
  });

  it("usb and wifi both connectable for one device -> a usb-only job", () => {
    const input = rows({
      devices: [deviceRow(1, true)],
      links: [
        linkRow({ id: "wifi-1", transport: "wifi", deviceId: 1 }),
        linkRow({ id: "usb-1", transport: "usb", deviceId: 1 }),
      ],
    });
    expect(plan(input, NOW)).toEqual([{ kind: "connect", linkId: "usb-1" }]);
  });

  it("closed_by_user -> no job ever, even though the link is otherwise connectable and owned", () => {
    const input = rows({
      devices: [deviceRow(1, true)],
      links: [linkRow({ id: "usb-1", transport: "usb", deviceId: 1, state: "closed_by_user", userClosed: true })],
    });
    expect(plan(input, NOW)).toEqual([]);
  });

  it("a failed link: no job before next_retry_at, a job at/after it", () => {
    const failed = linkRow({ id: "usb-1", transport: "usb", deviceId: 1, state: "failed", nextRetryAt: NOW + 1000 });
    const input = rows({ devices: [deviceRow(1, true)], links: [failed] });
    expect(plan(input, NOW)).toEqual([]);
    expect(plan(input, NOW + 999)).toEqual([]);
    expect(plan(input, NOW + 1000)).toEqual([{ kind: "connect", linkId: "usb-1" }]);
  });

  it("a radio link is never auto-connected, even when connectable and it is the only link the device has", () => {
    const input = rows({
      devices: [deviceRow(1, true)],
      links: [
        linkRow({ id: "radio-1", transport: "radio", deviceId: 1, address: { relayLinkId: "relay-1", channel: 1, group: 1 } }),
      ],
    });
    expect(plan(input, NOW)).toEqual([]);
  });

  it("an mbrelay link is never auto-connected either", () => {
    const input = rows({
      devices: [deviceRow(1, true)],
      links: [linkRow({ id: "mbrelay-1", transport: "mbrelay", deviceId: 1 })],
    });
    expect(plan(input, NOW)).toEqual([]);
  });

  it("nothing scheduled for a device with an already-open session, even on a different, more-preferred link", () => {
    const input = rows({
      devices: [deviceRow(1, true)],
      links: [
        linkRow({ id: "wifi-1", transport: "wifi", deviceId: 1, state: "connected" }),
        linkRow({ id: "usb-1", transport: "usb", deviceId: 1, state: "connectable" }),
      ],
      sessions: [{ linkId: "wifi-1" }],
    });
    expect(plan(input, NOW)).toEqual([]);
  });

  it("nothing scheduled while a job is already connecting for that device", () => {
    const input = rows({
      devices: [deviceRow(1, true)],
      links: [linkRow({ id: "usb-1", transport: "usb", deviceId: 1, state: "connecting" })],
    });
    expect(plan(input, NOW)).toEqual([]);
  });

  it("independent devices each get their own job in one plan() call", () => {
    const input = rows({
      devices: [deviceRow(1, true), deviceRow(2, true)],
      links: [
        linkRow({ id: "usb-1", transport: "usb", deviceId: 1 }),
        linkRow({ id: "wifi-2", transport: "wifi", deviceId: 2 }),
      ],
    });
    expect(plan(input, NOW)).toEqual([
      { kind: "connect", linkId: "usb-1" },
      { kind: "connect", linkId: "wifi-2" },
    ]);
  });
});

// ---------------------------------------------------------------------
// planUserOpen / planUserClose -- the user-forwarded session-open/
// session-close counterparts (rule 5, and the Description's "same
// precedence checks" requirement)
// ---------------------------------------------------------------------

describe("planUserOpen", () => {
  it("opens a plain connectable link with a connect job", () => {
    const input = rows({
      devices: [deviceRow(1, true)],
      links: [linkRow({ id: "wifi-1", transport: "wifi", deviceId: 1 })],
    });
    expect(planUserOpen(input, "wifi-1")).toEqual([{ kind: "connect", linkId: "wifi-1" }]);
  });

  it("never opens a wifi/mbserial link whose device is not owned, even on an explicit ask", () => {
    const input = rows({
      devices: [deviceRow(1, false)],
      links: [linkRow({ id: "wifi-1", transport: "wifi", deviceId: 1 })],
    });
    expect(planUserOpen(input, "wifi-1")).toEqual([]);
  });

  it("an explicit ask reopens a closed_by_user link -- architecture.md §5's own 'until asked'", () => {
    const input = rows({
      devices: [deviceRow(1, true)],
      links: [linkRow({ id: "usb-1", transport: "usb", deviceId: 1, state: "closed_by_user", userClosed: true })],
    });
    expect(planUserOpen(input, "usb-1")).toEqual([{ kind: "connect", linkId: "usb-1" }]);
  });

  it("opening a radio child with nothing else on its relay -> a plain connect job, not a switch", () => {
    const input = rows({
      links: [linkRow({ id: "radio-A", transport: "radio", address: { relayLinkId: "relay-1", channel: 1, group: 1 } })],
    });
    expect(planUserOpen(input, "radio-A")).toEqual([{ kind: "connect", linkId: "radio-A" }]);
  });

  it("a relay child switch is one job -- close the old child, open the new one -- never two separately-issued jobs", () => {
    const input = rows({
      links: [
        linkRow({ id: "radio-A", transport: "radio", address: { relayLinkId: "relay-1", channel: 1, group: 1 }, state: "connected" }),
        linkRow({ id: "radio-B", transport: "radio", address: { relayLinkId: "relay-1", channel: 2, group: 1 } }),
      ],
      sessions: [{ linkId: "radio-A" }],
    });
    expect(planUserOpen(input, "radio-B")).toEqual([
      { kind: "switchRelayChild", relayLinkId: "relay-1", closeLinkId: "radio-A", openLinkId: "radio-B" },
    ]);
  });

  it("detects an in-flight child via relay_leases even before its session row exists", () => {
    const input = rows({
      links: [
        linkRow({ id: "radio-A", transport: "radio", address: { relayLinkId: "relay-1", channel: 1, group: 1 }, state: "connecting" }),
        linkRow({ id: "radio-B", transport: "radio", address: { relayLinkId: "relay-1", channel: 2, group: 1 } }),
      ],
      relayLeases: [{ relayLinkId: "relay-1", owner: "session:radio-A" }],
    });
    expect(planUserOpen(input, "radio-B")).toEqual([
      { kind: "switchRelayChild", relayLinkId: "relay-1", closeLinkId: "radio-A", openLinkId: "radio-B" },
    ]);
  });

  it("asking to open the link that already occupies its own relay is a no-op", () => {
    const input = rows({
      links: [linkRow({ id: "radio-A", transport: "radio", address: { relayLinkId: "relay-1", channel: 1, group: 1 }, state: "connected" })],
      sessions: [{ linkId: "radio-A" }],
    });
    expect(planUserOpen(input, "radio-A")).toEqual([]);
  });

  it("an unknown linkId is a no-op, not a thrown error", () => {
    expect(planUserOpen(rows({}), "does-not-exist")).toEqual([]);
  });
});

describe("planUserClose", () => {
  it("closes an open (session-backed) link", () => {
    const input = rows({
      links: [linkRow({ id: "usb-1", transport: "usb", state: "connected" })],
      sessions: [{ linkId: "usb-1" }],
    });
    expect(planUserClose(input, "usb-1")).toEqual([{ kind: "close", linkId: "usb-1", reason: "user-requested" }]);
  });

  it("closes a link that is still connecting", () => {
    const input = rows({ links: [linkRow({ id: "usb-1", transport: "usb", state: "connecting" })] });
    expect(planUserClose(input, "usb-1")).toEqual([{ kind: "close", linkId: "usb-1", reason: "user-requested" }]);
  });

  it("closing a link with nothing open is a no-op", () => {
    const input = rows({ links: [linkRow({ id: "usb-1", transport: "usb", state: "connectable" })] });
    expect(planUserClose(input, "usb-1")).toEqual([]);
  });

  it("an unknown linkId is a no-op, not a thrown error", () => {
    expect(planUserClose(rows({}), "does-not-exist")).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// startReconciler -- the executor
// ---------------------------------------------------------------------

/** Flush pending microtasks -- same technique as `connector.test.ts`'s
 * own `flush()`. A macrotask boundary drains the whole microtask queue
 * first, however many hops deep. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Scheduler whose `delay()` resolves on the next microtask -- keeps a
 * plain (non-relay) transport's boot-window resend schedule instant. */
const immediateScheduler: Scheduler = { delay: () => Promise.resolve() };

/** `device NEZHA2 robot vevov 1198504156` -- `connector.test.ts`'s own
 * space-form robot fixture; `deviceIdToName(1198504156) === "vevov"`. */
const ROBOT_SERIAL = 1198504156;
const ROBOT_BANNER = `device NEZHA2 robot ${deviceIdToName(ROBOT_SERIAL)} ${ROBOT_SERIAL}`;

/** A `FakeByteStream` that answers `HELLO` with `bannerLine` -- mirrors
 * `connector.test.ts`'s own `BannerByteStream`, duplicated here (not
 * exported there) for the plain-transport executor test below. */
class BannerByteStream extends FakeByteStream {
  constructor(private readonly bannerLine: string) {
    super();
  }
  override write(bytes: string, callback: (err?: Error | null) => void): void {
    super.write(bytes, callback);
    if (bytes.startsWith("HELLO")) {
      this.emitData(`${this.bannerLine}\n`);
    }
  }
}

/** A `FakeByteStream` standing in for a relay's own physical port --
 * mirrors `connector.test.ts`'s own `RelayByteStream`, duplicated here
 * for the relay-child-switch executor test below. */
class RelayByteStream extends FakeByteStream {
  constructor(private readonly bannerLine: string) {
    super();
  }
  override write(bytes: string, callback: (err?: Error | null) => void): void {
    super.write(bytes, callback);
    const line = bytes.trim();
    if (line === "?") {
      this.emitData("# channel: 1 group: 1 mode: RAW250 power: 7\n");
    } else if (line === "!ECHO OFF") {
      this.emitData("# echo: OFF\n");
    } else if (line === "!MODE RAW250") {
      this.emitData("# mode: RAW250\n");
    } else if (/^!CG \d+ \d+$/.test(line)) {
      const match = /^!CG (\d+) (\d+)$/.exec(line);
      this.emitData(`# channel: ${match?.[1]} group: ${match?.[2]} mode: RAW250 power: 7\n`);
    } else if (line === "!P 7") {
      this.emitData("# channel: 47 group: 60 mode: RAW250 power: 7\n");
    } else if (line === "!GO") {
      this.emitData("# entering data plane\n");
    } else if (line.startsWith("HELLO")) {
      this.emitData(`${this.bannerLine}\n`);
    }
  }
}

describe("startReconciler -- in-flight dedupe (acceptance criterion 3)", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "robot-console-reconciler-test-"));
    store = new Store(openStoreDb({ filePath: path.join(dir, "console.sqlite") }));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("never re-issues a job already in flight for the same link, even if a rows read still shows it eligible", async () => {
    store.upsertDevice({ id: ROBOT_SERIAL, name: deviceIdToName(ROBOT_SERIAL), kind: "robot", at: 1 });
    store.setOwned(ROBOT_SERIAL, true, 1);
    store.upsertLink({ id: "wifi-1", transport: "wifi", address: { host: "10.0.0.5", port: 4000 }, deviceId: ROBOT_SERIAL, at: 1 });
    store.setLinkState({ id: "wifi-1", state: "connectable", at: 1 });

    // A snapshot that always claims "wifi-1 is connectable" regardless
    // of what the real row's state has since become -- isolates the
    // executor's own `inFlight` set from the (also-correct, but
    // separate) store-state-based gate `plan()`/`planUserOpen` apply,
    // by never letting that gate see the 'connecting' write `runConnect`
    // itself makes.
    const staleRows: ReconcilerRows = {
      devices: [{ id: ROBOT_SERIAL, kind: "robot", owned: true }],
      links: [
        {
          id: "wifi-1",
          deviceId: ROBOT_SERIAL,
          transport: "wifi",
          address: { host: "10.0.0.5", port: 4000 },
          state: "connectable",
          nextRetryAt: null,
          failCount: 0,
          userClosed: false,
        },
      ],
      sessions: [],
      relayLeases: [],
    };
    store.reconcilerRows = (): ReconcilerRows => staleRows;

    let connectCalls = 0;
    const connector: Connector = {
      connectAndIdentify: () => {
        connectCalls++;
        return new Promise<ConnectedSession>(() => {
          // never settles -- this attempt is still "in flight" for the
          // whole test.
        });
      },
    };

    const reconciler = startReconciler(store, { connector, now: () => NOW, tickIntervalMs: 1_000_000 });
    try {
      // The constructor's own initial tick() already dispatched one
      // connect job synchronously.
      expect(connectCalls).toBe(1);

      // A second, explicit ask for the very same link while the first
      // is still in flight -- the stale rows read would, on its own,
      // say this is still eligible; only `inFlight` stops a second
      // `connectAndIdentify` call.
      await reconciler.requestOpen("wifi-1");
      expect(connectCalls).toBe(1);

      // The slow tick would make the same mistake too, if it ran again
      // before this attempt settled.
      await reconciler.requestOpen("wifi-1");
      expect(connectCalls).toBe(1);
    } finally {
      reconciler.stop();
    }
  });
});

describe("startReconciler -- executor integration (real connector, fake ByteStream)", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "robot-console-reconciler-integ-test-"));
    store = new Store(openStoreDb({ filePath: path.join(dir, "console.sqlite") }));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("auto-connects an owned, connectable wifi link on start and identifies it over the real connector", async () => {
    store.upsertDevice({ id: ROBOT_SERIAL, name: deviceIdToName(ROBOT_SERIAL), kind: "robot", at: 1 });
    store.setOwned(ROBOT_SERIAL, true, 1);
    store.upsertLink({ id: "wifi-1", transport: "wifi", address: { host: "10.0.0.5", port: 4000 }, deviceId: ROBOT_SERIAL, at: 1 });
    store.setLinkState({ id: "wifi-1", state: "connectable", at: 1 });

    const stream = new BannerByteStream(ROBOT_BANNER);
    const connector = createConnector(store, {
      createTcpStream: () => stream,
      scheduler: immediateScheduler,
      now: () => NOW,
    });

    const reconciler = startReconciler(store, { connector, now: () => NOW, tickIntervalMs: 1_000_000 });
    try {
      await flush(); // let the (no-mutex) wifi attempt reach stream.open()
      stream.resolveOpen();
      await flush();
      await flush();

      const linkRowAfter = store.snapshotRows().links.find((l) => l.id === "wifi-1");
      expect(linkRowAfter?.state).toBe("connected");
      expect(store.snapshotRows().sessions.find((s) => s.link_id === "wifi-1")).toBeDefined();
      expect(stream.writes[0]?.bytes.startsWith("HELLO")).toBe(true);
    } finally {
      reconciler.stop();
    }
  });

  it("never auto-bridges a connectable radio link (architecture.md §8 rule 5)", async () => {
    store.upsertLink({ id: "usb-RELAY", transport: "usb", address: { path: "/dev/cu.relay" }, at: 1 });
    store.upsertLink({ id: "radio-A", transport: "radio", address: { relayLinkId: "usb-RELAY", channel: 47, group: 60 }, at: 1 });
    store.setLinkState({ id: "radio-A", state: "connectable", at: 1 });

    let opens = 0;
    const connector: Connector = {
      connectAndIdentify: () => {
        opens++;
        return new Promise<ConnectedSession>(() => {});
      },
    };

    const reconciler = startReconciler(store, { connector, now: () => NOW, tickIntervalMs: 1_000_000 });
    try {
      expect(opens).toBe(0);
    } finally {
      reconciler.stop();
    }
  });

  it("a relay child switch (requestOpen for a second child) closes the old child then opens the new one, as one job", async () => {
    store.upsertLink({ id: "usb-RELAY", transport: "usb", address: { path: "/dev/cu.relay" }, at: 1 });
    store.upsertLink({ id: "radio-A", transport: "radio", address: { relayLinkId: "usb-RELAY", channel: 47, group: 60 }, at: 1 });
    store.setLinkState({ id: "radio-A", state: "connectable", at: 1 });
    store.upsertLink({ id: "radio-B", transport: "radio", address: { relayLinkId: "usb-RELAY", channel: 49, group: 61 }, at: 1 });
    store.setLinkState({ id: "radio-B", state: "connectable", at: 1 });

    let currentStream: RelayByteStream | undefined;
    const connector = createConnector(store, {
      createSerialStream: () => {
        currentStream = new RelayByteStream(ROBOT_BANNER);
        return currentStream;
      },
      scheduler: realScheduler,
      now: () => NOW,
    });

    const reconciler = startReconciler(store, { connector, now: () => NOW, tickIntervalMs: 1_000_000 });
    try {
      // Radio bridging is user-initiated -- nothing auto-connects on
      // start (covered by the previous test too), so explicitly open A.
      const openA = reconciler.requestOpen("radio-A");
      await flush();
      currentStream?.resolveOpen();
      await openA;

      expect(store.snapshotRows().links.find((l) => l.id === "radio-A")?.state).toBe("connected");
      expect(store.snapshotRows().sessions.find((s) => s.link_id === "radio-A")).toBeDefined();
      const streamA = currentStream;

      // Now ask for B on the same physical relay -- must be one job:
      // close A, then open B, never two separately-issued jobs.
      const openB = reconciler.requestOpen("radio-B");
      await flush();
      currentStream?.resolveOpen();
      await openB;

      expect(streamA?.closeCallCount).toBeGreaterThanOrEqual(1);
      const rowA = store.snapshotRows().links.find((l) => l.id === "radio-A");
      expect(rowA?.state).toBe("closed_by_user");
      expect(store.snapshotRows().sessions.find((s) => s.link_id === "radio-A")).toBeUndefined();

      const rowB = store.snapshotRows().links.find((l) => l.id === "radio-B");
      expect(rowB?.state).toBe("connected");
      expect(store.snapshotRows().sessions.find((s) => s.link_id === "radio-B")).toBeDefined();
    } finally {
      reconciler.stop();
    }
  }, 10_000);
});
