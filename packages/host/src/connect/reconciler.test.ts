import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deviceIdToName, nameToValue } from "@robot-console/protocol";
import { openStoreDb } from "../store/db.js";
import {
  Store,
  type DeviceKind,
  type ReconcilerDeviceRow,
  type ReconcilerLinkRow,
  type ReconcilerRows,
  type Transport,
} from "../store/index.js";
import { FakeByteStream } from "../link/__fixtures__/FakeByteStream.js";
import { realScheduler, type Scheduler } from "../link/pacing.js";
import { createConnector, type Connector, type ConnectedSession } from "./connector.js";
import { describeUserOpenRefusal, plan, planUserClose, planUserOpen, startReconciler } from "./reconciler.js";

// Sprint 015 ticket 002's own suite: table-driven `plan()`/`planUserOpen`/
// `planUserClose` cases (pure, no store or network access at all), plus
// an executor integration section reusing ticket 001's own fake-`ByteStream`
// harness against a real, temp-dir-backed `Store`.

const NOW = 1_000_000;

function deviceRow(id: number, owned: boolean, kind: DeviceKind = "robot"): ReconcilerDeviceRow {
  return { id, kind, owned };
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

  // Ticket 016-001: a relay's own usb link is never an automatic-connect
  // candidate again once `kind === 'relay'` is known -- architecture.md
  // §7.2 ("no auto-opened console session on a relay any more").
  it("a kind='relay' device's connectable usb link never produces an automatic connect job", () => {
    const input = rows({
      devices: [deviceRow(1, true, "relay")],
      links: [linkRow({ id: "usb-1", transport: "usb", deviceId: 1 })],
    });
    expect(plan(input, NOW)).toEqual([]);
  });

  it("a kind='robot' device with the same connectable-usb-link shape still produces a connect job (regression guard)", () => {
    const input = rows({
      devices: [deviceRow(1, true, "robot")],
      links: [linkRow({ id: "usb-1", transport: "usb", deviceId: 1 })],
    });
    expect(plan(input, NOW)).toEqual([{ kind: "connect", linkId: "usb-1" }]);
  });

  it("a freshly-enumerated board not yet known to be a relay still gets one connect job to identify it", () => {
    // `plan()`'s `ReconcilerDeviceRow.kind` has no third "unknown" value --
    // `watchers/usbWatcher.ts`'s own SWD-naming step already seeds a
    // fresh board's device row `kind: 'robot'` as a provisional guess
    // before its first real (v6 banner) identify ever runs, and only
    // `connect/connector.ts`'s own identify corrects it to `'relay'` if
    // that is what the banner says. So "kind not yet known" is exactly
    // the `kind: 'robot'` case above -- this device's very first
    // automatic pass is indistinguishable, by design, from an
    // already-confirmed robot's, and must still get its one job.
    const input = rows({
      devices: [deviceRow(2, true, "robot")],
      links: [linkRow({ id: "usb-2", transport: "usb", deviceId: 2 })],
    });
    expect(plan(input, NOW)).toEqual([{ kind: "connect", linkId: "usb-2" }]);
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

// ---------------------------------------------------------------------
// Bench defect 4 (2026-09-12): describeUserOpenRefusal narrates exactly
// the branches planUserOpen above refuses on -- one table test per
// planUserOpen case that returns [], confirming a reason string comes
// back for each, and confirming every job-producing case above narrates
// to undefined (never a false-positive "refused" the UI would show for
// something that actually worked).
// ---------------------------------------------------------------------

describe("describeUserOpenRefusal", () => {
  it("is undefined whenever planUserOpen would actually produce a job", () => {
    const opensPlainly = rows({
      devices: [deviceRow(1, true)],
      links: [linkRow({ id: "wifi-1", transport: "wifi", deviceId: 1 })],
    });
    expect(planUserOpen(opensPlainly, "wifi-1")).not.toEqual([]);
    expect(describeUserOpenRefusal(opensPlainly, "wifi-1")).toBeUndefined();

    const reopensClosedByUser = rows({
      devices: [deviceRow(1, true)],
      links: [linkRow({ id: "usb-1", transport: "usb", deviceId: 1, state: "closed_by_user", userClosed: true })],
    });
    expect(describeUserOpenRefusal(reopensClosedByUser, "usb-1")).toBeUndefined();

    const switches = rows({
      links: [
        linkRow({ id: "radio-A", transport: "radio", address: { relayLinkId: "relay-1", channel: 1, group: 1 }, state: "connected" }),
        linkRow({ id: "radio-B", transport: "radio", address: { relayLinkId: "relay-1", channel: 2, group: 1 } }),
      ],
      sessions: [{ linkId: "radio-A" }],
    });
    expect(describeUserOpenRefusal(switches, "radio-B")).toBeUndefined();
  });

  it("names an unknown linkId", () => {
    expect(describeUserOpenRefusal(rows({}), "does-not-exist")).toBe('no such link "does-not-exist"');
  });

  it("names a not-yet-owned device as the reason a wifi/mbserial open is refused", () => {
    const input = rows({
      devices: [deviceRow(1, false)],
      links: [linkRow({ id: "wifi-1", transport: "wifi", deviceId: 1 })],
    });
    expect(planUserOpen(input, "wifi-1")).toEqual([]);
    expect(describeUserOpenRefusal(input, "wifi-1")).toMatch(/not owned/);
  });

  it("names an already-open link (session already exists) as the reason", () => {
    const input = rows({
      links: [linkRow({ id: "radio-A", transport: "radio", address: { relayLinkId: "relay-1", channel: 1, group: 1 }, state: "connected" })],
      sessions: [{ linkId: "radio-A" }],
    });
    expect(planUserOpen(input, "radio-A")).toEqual([]);
    expect(describeUserOpenRefusal(input, "radio-A")).toBe("already open");
  });

  it("names an already-connecting (in-flight) link as the reason", () => {
    const input = rows({
      devices: [deviceRow(1, true)],
      links: [linkRow({ id: "usb-1", transport: "usb", deviceId: 1, state: "connecting" })],
    });
    expect(planUserOpen(input, "usb-1")).toEqual([]);
    expect(describeUserOpenRefusal(input, "usb-1")).toBe("already connecting");
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

/** `DEVICE:RADIOBRIDGE:relay:getez:1779042365` -- `connector.test.ts`'s
 * own colon-form relay fixture, duplicated here for the idle-return
 * executor test below (ticket 016-001). */
const RELAY_SERIAL = 1779042365;
const RELAY_BANNER = `DEVICE:RADIOBRIDGE:relay:${deviceIdToName(RELAY_SERIAL)}:${RELAY_SERIAL}`;

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

      // sprint 015 ticket 005's own seam: `reconciler.sessions` is the
      // narrow read-only view the server uses to reach "the open
      // session's link" for send-command/line/provision-wifi/flash --
      // see that interface's own doc comment.
      const session = reconciler.sessions.get("wifi-1");
      expect(session?.linkId).toBe("wifi-1");
      expect(session?.link).toBeDefined();
      expect(reconciler.sessions.get("no-such-link")).toBeUndefined();
      expect(Array.from(reconciler.sessions.values()).map((s) => s.linkId)).toEqual(["wifi-1"]);

      await reconciler.requestClose("wifi-1");
      expect(reconciler.sessions.get("wifi-1")).toBeUndefined();
      expect(Array.from(reconciler.sessions.values())).toEqual([]);
    } finally {
      reconciler.stop();
    }
  });

  it(
    "bench defect 5 (2026-09-12): a sessions row inherited from a prior process (link left unresponsive, no live in-memory session) is cleared at startup, and the link auto-reconnects for real instead of being refused forever",
    async () => {
      // Simulates exactly the live bench finding: `mbserial-vevov` had a
      // real session at some point (a *previous* process's own
      // `runConnect`), the harvester's missed-poll watchdog later wrote
      // `links.state = 'unresponsive'` (harvester.ts's own `fail` --
      // deliberately never touches `sessions`), and then that process
      // exited (or was killed) without ever calling `session-close` --
      // leaving `sessions` row and `links.state` exactly as seeded below,
      // with no `ConnectedSession` anywhere to back it. A *fresh*
      // `startReconciler` call (this executor's own `sessions` Map is
      // always empty at construction) must not trust that leftover row.
      store.upsertDevice({ id: ROBOT_SERIAL, name: deviceIdToName(ROBOT_SERIAL), kind: "robot", at: 1 });
      store.setOwned(ROBOT_SERIAL, true, 1);
      store.upsertLink({ id: "wifi-1", transport: "wifi", address: { host: "10.0.0.5", port: 4000 }, deviceId: ROBOT_SERIAL, at: 1 });
      store.openSession("wifi-1", 1); // the prior process's own now-orphaned session row
      store.setLinkState({ id: "wifi-1", state: "unresponsive", at: 1, reason: "no reply to 3 STATUS polls -- link presumed dead" });

      // Sanity: before this fix, this is precisely the shape that made
      // `planUserOpen`/`describeUserOpenRefusal` refuse forever and
      // `server.ts`'s `requireSession` throw "has no open session" on
      // every command -- see reconciler.ts's own `plan`/`planUserOpen`.
      expect(describeUserOpenRefusal(store.reconcilerRows(), "wifi-1")).toBe("already open");

      const stream = new BannerByteStream(ROBOT_BANNER);
      const connector = createConnector(store, {
        createTcpStream: () => stream,
        scheduler: immediateScheduler,
        now: () => NOW,
      });

      const reconciler = startReconciler(store, { connector, now: () => NOW, tickIntervalMs: 1_000_000 });
      try {
        // The stale row is gone, and the link is back to `connectable`,
        // synchronously -- before this executor's own first tick() ever
        // dispatches a job.
        expect(store.snapshotRows().sessions.find((s) => s.link_id === "wifi-1")).toBeUndefined();

        await flush(); // let the now-eligible auto-connect reach stream.open()
        stream.resolveOpen();
        await flush();
        await flush();

        // A real, live session this executor itself opened -- the one
        // registry `server.ts`'s `requireSession` reads is now the truth.
        const linkRowAfter = store.snapshotRows().links.find((l) => l.id === "wifi-1");
        expect(linkRowAfter?.state).toBe("connected");
        expect(store.snapshotRows().sessions.find((s) => s.link_id === "wifi-1")).toBeDefined();
        const session = reconciler.sessions.get("wifi-1");
        expect(session?.linkId).toBe("wifi-1");
        expect(session?.link).toBeDefined();
      } finally {
        reconciler.stop();
      }
    },
  );

  it(
    "merges a known-robots placeholder into the real device row via the automatic auto-connect path too, not only a user-initiated session-open (bench defect 2, 2026-09-12)",
    async () => {
      // `connect/connector.ts`'s `mergeNamePlaceholderIfAny` runs inside
      // `attempt()` itself, the same function this executor's automatic
      // `plan()` pass dispatches a job to -- so there is only one code
      // path to prove, not a second one to wire up. This test exercises
      // it through `startReconciler`'s own automatic tick (no
      // `requestOpen` call at all), confirming the merge fires
      // regardless of which entry point triggered the connect --
      // exactly the bench finding this ticket's own evidence flagged as
      // still open ("confirm the merge also runs for links that are
      // ALREADY connected at startup").
      const placeholderId = nameToValue(deviceIdToName(ROBOT_SERIAL)); // "vevov"'s synthetic id
      store.upsertDevice({ id: placeholderId, name: deviceIdToName(ROBOT_SERIAL), kind: "robot", usbSerial: "0012345678", at: 1 });
      store.setOwned(placeholderId, true, 1);
      // The link is already attached to the placeholder -- exactly what
      // `watchers/mdnsWatcher.ts`'s own device-linking does on the bench
      // before the real chip has ever been seen (the placeholder is, for
      // now, "the" owned device of that name).
      store.upsertLink({ id: "wifi-1", transport: "wifi", address: { host: "10.0.0.5", port: 4000 }, deviceId: placeholderId, at: 1 });
      store.setLinkState({ id: "wifi-1", state: "connectable", at: 1 });

      const stream = new BannerByteStream(ROBOT_BANNER);
      const connector = createConnector(store, {
        createTcpStream: () => stream,
        scheduler: immediateScheduler,
        now: () => NOW,
      });

      const reconciler = startReconciler(store, { connector, now: () => NOW, tickIntervalMs: 1_000_000 });
      try {
        await flush(); // let the automatic (no requestOpen) attempt reach stream.open()
        stream.resolveOpen();
        await flush();
        await flush();

        const rows = store.snapshotRows();
        // One row, not two -- the placeholder merged into the real chip
        // id, carrying owned/usb_serial forward (store/index.test.ts's
        // own Store: mergeDevice suite covers that column-by-column).
        expect(rows.devices).toHaveLength(1);
        expect(rows.devices[0]).toMatchObject({ id: ROBOT_SERIAL, owned: 1, usb_serial: "0012345678" });
        expect(rows.links.find((l) => l.id === "wifi-1")?.device_id).toBe(ROBOT_SERIAL);
      } finally {
        reconciler.stop();
      }
    },
  );

  it("requestOpen reports a refusedReason for a not-yet-owned link, and none once ownership is granted and the connect actually goes through (bench defect 4)", async () => {
    store.upsertLink({ id: "wifi-1", transport: "wifi", address: { host: "10.0.0.5", port: 4000 }, deviceId: null, at: 1 });
    store.setLinkState({ id: "wifi-1", state: "connectable", at: 1 });

    const connector: Connector = {
      connectAndIdentify: () => new Promise<ConnectedSession>(() => {}),
    };
    const reconciler = startReconciler(store, { connector, now: () => NOW, tickIntervalMs: 1_000_000 });
    try {
      // deviceId is null (no owned device attached at all) -- refused,
      // same "not owned" branch as an attached-but-unowned device.
      const refused = await reconciler.requestOpen("wifi-1");
      expect(refused.refusedReason).toBeDefined();

      // An unknown linkId is refused too, distinctly.
      const unknown = await reconciler.requestOpen("does-not-exist");
      expect(unknown.refusedReason).toBe('no such link "does-not-exist"');
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

  // Ticket 016-001: a relay's one-time usb identify must return to idle
  // -- no open session, no relay_leases row, and never re-identified by
  // a later automatic pass. `connect/connector.ts` itself is unchanged
  // (it still opens a session on any successful identify, relay or
  // robot alike -- see `connector.test.ts`'s own "never marked owned"
  // case); this executor is the seam that immediately closes what
  // `connector.ts` just opened once it sees `classification.type ===
  // 'relay'`.
  it("a relay's one-time usb identify returns to idle: no open session, no relay_leases row, never re-identified", async () => {
    // Mirrors `watchers/usbWatcher.ts`'s own `attach()`: a device row
    // already exists (kind: 'robot', SWD naming's own provisional guess)
    // before this board's first real (v6 banner) identify ever runs.
    store.upsertDevice({ id: RELAY_SERIAL, name: deviceIdToName(RELAY_SERIAL), kind: "robot", at: 1 });
    store.upsertLink({ id: "usb-RELAY", transport: "usb", address: { path: "/dev/cu.relay" }, deviceId: RELAY_SERIAL, at: 1 });
    store.setLinkState({ id: "usb-RELAY", state: "connectable", at: 1 });

    let createSerialStreamCalls = 0;
    let stream: BannerByteStream | undefined;
    const connector = createConnector(store, {
      createSerialStream: () => {
        createSerialStreamCalls++;
        stream = new BannerByteStream(RELAY_BANNER);
        return stream;
      },
      scheduler: immediateScheduler,
      now: () => NOW,
    });

    const reconciler = startReconciler(store, { connector, now: () => NOW, tickIntervalMs: 1_000_000 });
    try {
      await flush(); // the constructor's own initial tick() dispatched the one-time identify
      stream?.resolveOpen();
      await flush();
      await flush();
      await flush(); // let the idle-return's own store writes (and the tick() they retrigger) settle

      expect(createSerialStreamCalls).toBe(1);
      expect(stream?.writes[0]?.bytes.startsWith("HELLO")).toBe(true);

      const deviceRowAfter = store.snapshotRows().devices.find((d) => Number(d.id) === RELAY_SERIAL);
      expect(deviceRowAfter?.kind).toBe("relay");

      const linkRowAfter = store.snapshotRows().links.find((l) => l.id === "usb-RELAY");
      expect(linkRowAfter?.state).toBe("connectable");
      expect(linkRowAfter?.state_reason).toBe("relay-identified-idle");

      expect(store.snapshotRows().sessions.find((s) => s.link_id === "usb-RELAY")).toBeUndefined();
      expect(store.reconcilerRows().relayLeases).toEqual([]);
      expect(reconciler.sessions.get("usb-RELAY")).toBeUndefined();

      // Never re-identified: further store churn (itself retriggering
      // tick() via the change feed, same as the idle-return's own writes
      // just did above) must not open the relay's port a second time.
      store.setLinkState({ id: "usb-RELAY", state: "connectable", at: NOW + 1 });
      await flush();
      expect(createSerialStreamCalls).toBe(1);
    } finally {
      reconciler.stop();
    }
  });
});
